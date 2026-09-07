import { expect, layer } from "@effect/vitest";
import {
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Result,
} from "effect";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import { SqlClient, Statement } from "effect/unstable/sql";
import { PersistedQueue } from "effect/unstable/persistence";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { findPendingConsentExchange, removePendingConsentExchange } from "~/shell/consent/repo";
import { handleOnboardingTurn } from "~/shell/onboarding/onboarding";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import {
  ConsentDisclosureWorkflowLive,
  applyConsentDisclosureLifecycle,
  performConsentDisclosureAttempt,
  requestConsentDisclosureDelivery,
  startNextConsentDisclosureEvidence,
} from "./disclosure-delivery";
import {
  DisclosureDeliveryAttemptNumber,
  DisclosureDeliveryCorrelationToken,
} from "./disclosure-model";
import { ConsentDisclosureWorkflow, disclosureEvidenceQueueId } from "./disclosure-workflow";
import {
  findConsentDisclosureAttemptByCorrelation,
  findConsentDisclosureDeliveryState,
  lockConsentDisclosure,
} from "./disclosure-store";
import { KapsoClient, type KapsoClientService, KapsoSendFailed } from "./kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

const admit = Effect.fn(function* (phone: string) {
  const caller = testWhatsAppCaller(E164PhoneNumber.make(phone));
  const previous = yield* findPendingConsentExchange(caller);
  if (Option.isSome(previous)) yield* removePendingConsentExchange(previous.value.id);
  const now = yield* DateTime.now;
  const message = WhatsAppMessageEvidence.make({
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(`wamid.cluster-${phone}`),
  });
  const admission = yield* handleOnboardingTurn({
    caller,
    content: { _tag: "Text", text: "Hola" },
    message,
    receivedAt: now,
  });
  if (admission._tag !== "SendDisclosure") return yield* Effect.die("expected disclosure");
  yield* requestConsentDisclosureDelivery({
    exchangeId: admission.exchangeId,
    event: {
      caller,
      messageEvidence: message,
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
      content: { _tag: "Text", text: TranscriptText.make("Hola") },
      occurredAt: now,
      receivedAt: now,
    },
    beforeProviderCall: Effect.void,
  });
  return { exchangeId: admission.exchangeId, revision: 1 as const };
});

const acquireRuntime = Effect.fn(function* (
  port: number,
  client: KapsoClientService,
  transformer?: Statement.Transformer
) {
  const crypto = yield* Crypto.Crypto;
  const runtimeLayer = Layer.effectDiscard(
    startNextConsentDisclosureEvidence().pipe(Effect.forever, Effect.forkScoped)
  ).pipe(
    Layer.provideMerge(ConsentDisclosureWorkflowLive),
    Layer.provide(Layer.succeed(Statement.CurrentTransformer, transformer)),
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql("c".repeat(64), {
            runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            availableShardGroups: ["default"],
            assignedShardGroups: ["default"],
            shardsPerGroup: 300,
            entityMessagePollInterval: 50,
            sendRetryInterval: 50,
            entityTerminationTimeout: 100,
          })
        )
      )
    ),
    Layer.provide(Layer.succeed(KapsoClient, client)),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, crypto)),
    Layer.provideMerge(
      PersistedQueue.layer.pipe(
        Layer.provideMerge(PersistedQueue.layerStoreSql({ tableName: "fidy_queue" }))
      )
    ),
    Layer.provideMerge(PgLive)
  );

  return yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(runtimeLayer)),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
});

const delivered = (
  messageId: string,
  sentAt: DateTime.Utc
): Effect.Success<ReturnType<KapsoClientService["sendText"]>> => ({
  messageEvidence: WhatsAppMessageEvidence.make({
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(messageId),
  }),
  sentAt,
  responseStatus: TelemetryHttpStatus.make(200),
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "SQL Cluster Consent disclosure delivery",
  (it) => {
    it.effect(
      "coordinates duplicate execution across two runtimes and accepts delivery before send settlement",
      Effect.fn(function* () {
        expect.assertions(7);
        const payload = yield* admit("+573007774671");
        const calls = yield* Ref.make(0);
        const started =
          yield* Deferred.make<Parameters<typeof applyConsentDisclosureLifecycle>[0]>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Ref.make(0);
        const provider = (runner: number): KapsoClientService => ({
          sendText: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              yield* Ref.set(owner, runner);
              const result = delivered("wamid.cluster-delivered-466", yield* DateTime.now);
              const correlationToken = yield* Effect.fromOption(input.opaqueCallbackData).pipe(
                Effect.orDie
              );
              yield* Deferred.succeed(started, {
                outcome: "accepted",
                correlationToken,
                messageEvidence: result.messageEvidence,
                occurredAt: result.sentAt,
              });
              yield* Deferred.await(release);
              return result;
            }),
        });
        const first = yield* acquireRuntime(44661, provider(1));
        const second = yield* acquireRuntime(44662, provider(2));
        yield* Effect.tryPromise(() => first.runPromise(Effect.void));
        yield* Effect.tryPromise(() => second.runPromise(Effect.void));
        yield* Effect.tryPromise(() =>
          Promise.all([
            first.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true })),
            second.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true })),
          ])
        );
        const evidence = yield* Deferred.await(started);
        const remote = (yield* Ref.get(owner)) === 1 ? second : first;
        const before = yield* findConsentDisclosureDeliveryState(payload.exchangeId);
        const correlated = yield* findConsentDisclosureAttemptByCorrelation(
          evidence.correlationToken
        ).pipe(Effect.flatMap(Effect.fromOption));
        const rollback = yield* Effect.tryPromise(() =>
          remote.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql
                .withTransaction(
                  applyConsentDisclosureLifecycle(evidence).pipe(
                    Effect.andThen(Effect.fail("rollback"))
                  )
                )
                .pipe(Effect.result);
            })
          )
        );
        expect(Result.isFailure(rollback)).toBe(true);
        expect(yield* findConsentDisclosureDeliveryState(payload.exchangeId)).toEqual(before);
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT id FROM fidy_queue WHERE queue_name = 'whatsapp-consent-disclosure-evidence' AND id = ${disclosureEvidenceQueueId(correlated)}`
        ).toEqual([]);
        expect(
          yield* Effect.tryPromise(() =>
            remote.runPromise(applyConsentDisclosureLifecycle(evidence))
          )
        ).toBe("applied");
        expect(
          yield* Effect.tryPromise(() =>
            remote.runPromise(applyConsentDisclosureLifecycle(evidence))
          )
        ).toBe("ignored");
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.tryPromise(() =>
          Promise.all([
            first.runPromise(ConsentDisclosureWorkflow.execute(payload)),
            second.runPromise(ConsentDisclosureWorkflow.execute(payload)),
          ])
        );
        expect(results).toEqual([{ outcome: "delivered" }, { outcome: "delivered" }]);
        expect(yield* Ref.get(calls)).toBe(1);
      }),
      30_000
    );

    it.effect(
      "does not resend an armed attempt after process loss and resumes from verified evidence",
      Effect.fn(function* () {
        expect.assertions(3);
        const payload = yield* admit("+573007774672");
        const calls = yield* Ref.make(0);
        const started =
          yield* Deferred.make<Parameters<typeof applyConsentDisclosureLifecycle>[0]>();
        const provider: KapsoClientService = {
          sendText: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              const result = delivered("wamid.cluster-crash-466", yield* DateTime.now);
              const correlationToken = yield* Effect.fromOption(input.opaqueCallbackData).pipe(
                Effect.orDie
              );
              yield* Deferred.succeed(started, {
                outcome: "accepted",
                correlationToken,
                messageEvidence: result.messageEvidence,
                occurredAt: result.sentAt,
              });
              return yield* Effect.never;
            }),
        };
        const first = yield* acquireRuntime(44663, provider);
        yield* Effect.tryPromise(() =>
          first.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        const evidence = yield* Deferred.await(started);
        yield* Effect.tryPromise(() => first.dispose());
        const recovered = yield* acquireRuntime(44664, provider);
        yield* Effect.tryPromise(() =>
          recovered.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        expect(
          yield* Effect.tryPromise(() =>
            recovered.runPromise(applyConsentDisclosureLifecycle(evidence))
          )
        ).toBe("applied");
        expect(
          yield* Effect.tryPromise(() =>
            recovered.runPromise(ConsentDisclosureWorkflow.execute(payload))
          )
        ).toEqual({ outcome: "delivered" });
        expect(yield* Ref.get(calls)).toBe(1);
      }),
      30_000
    );

    it.effect(
      "resumes a persisted retry clock after restart without retrying before its deadline",
      Effect.fn(function* () {
        expect.assertions(3);
        const payload = yield* admit("+573007774673");
        const calls = yield* Ref.make(0);
        const sent = yield* Deferred.make<Parameters<typeof applyConsentDisclosureLifecycle>[0]>();
        const times = yield* Ref.make<ReadonlyArray<number>>([]);
        const provider: KapsoClientService = {
          sendText: (input) =>
            Effect.gen(function* () {
              const ordinal = yield* Ref.updateAndGet(calls, (count) => count + 1);
              const now = yield* DateTime.now;
              yield* Ref.update(times, (values) => [...values, DateTime.toEpochMillis(now)]);
              if (ordinal === 1) {
                return yield* new KapsoSendFailed({
                  deliveryCertainty: "rejected",
                  safeReason: "provider_unavailable",
                  automaticRetry: true,
                  responseStatus: Option.none(),
                });
              }
              const result = delivered("wamid.cluster-retry-466", now);
              const correlationToken = yield* Effect.fromOption(input.opaqueCallbackData).pipe(
                Effect.orDie
              );
              yield* Deferred.succeed(sent, {
                outcome: "accepted",
                correlationToken,
                messageEvidence: result.messageEvidence,
                occurredAt: now,
              });
              return result;
            }),
        };
        const first = yield* acquireRuntime(44665, provider);
        yield* Effect.tryPromise(() =>
          first.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        const executionId = yield* ConsentDisclosureWorkflow.executionId(payload);
        yield* Effect.tryPromise(() =>
          first.runPromise(
            Effect.gen(function* () {
              while (true) {
                const state = yield* ConsentDisclosureWorkflow.poll(executionId);
                if (Option.isSome(state) && state.value._tag === "Suspended") return;
                yield* Effect.sleep("20 millis");
              }
            }).pipe(Effect.timeout("5 seconds"))
          )
        );
        yield* Effect.tryPromise(() => first.dispose());
        const recovered = yield* acquireRuntime(44666, provider);
        yield* Effect.tryPromise(() =>
          recovered.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        const evidence = yield* Deferred.await(sent);
        yield* Effect.tryPromise(() =>
          recovered.runPromise(applyConsentDisclosureLifecycle(evidence))
        );
        expect(
          yield* Effect.tryPromise(() =>
            recovered.runPromise(ConsentDisclosureWorkflow.execute(payload))
          )
        ).toEqual({ outcome: "delivered" });
        expect(yield* Ref.get(calls)).toBe(2);
        const timestamps = yield* Ref.get(times);
        expect((timestamps[1] ?? 0) - (timestamps[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
      }),
      30_000
    );

    it.effect(
      "keeps terminal rejection observable without closing later verified delivery",
      Effect.fn(function* () {
        expect.assertions(3);
        const payload = yield* admit("+573007774674");
        const started =
          yield* Deferred.make<Parameters<typeof applyConsentDisclosureLifecycle>[0]>();
        const provider: KapsoClientService = {
          sendText: (input) =>
            Effect.gen(function* () {
              const result = delivered("wamid.cluster-late-466", yield* DateTime.now);
              const correlationToken = yield* Effect.fromOption(input.opaqueCallbackData).pipe(
                Effect.orDie
              );
              yield* Deferred.succeed(started, {
                outcome: "accepted",
                correlationToken,
                messageEvidence: result.messageEvidence,
                occurredAt: result.sentAt,
              });
              return yield* new KapsoSendFailed({
                deliveryCertainty: "rejected",
                safeReason: "provider_unavailable",
                automaticRetry: false,
                responseStatus: Option.none(),
              });
            }),
        };
        const runtime = yield* acquireRuntime(44667, provider);
        yield* Effect.tryPromise(() =>
          runtime.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        const evidence = yield* Deferred.await(started);
        const executionId = yield* ConsentDisclosureWorkflow.executionId(payload);
        const waiting = yield* Effect.tryPromise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              while (true) {
                const state = yield* ConsentDisclosureWorkflow.poll(executionId);
                if (Option.isSome(state) && state.value._tag === "Suspended") return state.value;
                yield* Effect.sleep("20 millis");
              }
            }).pipe(Effect.timeout("5 seconds"))
          )
        );
        expect(waiting._tag).toBe("Suspended");
        const latest = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        expect(latest.state).toBe("definitively-failed");
        const occurredAt = yield* DateTime.now;
        yield* Effect.tryPromise(() =>
          runtime.runPromise(applyConsentDisclosureLifecycle({ ...evidence, occurredAt }))
        );
        expect(
          yield* Effect.tryPromise(() =>
            runtime.runPromise(ConsentDisclosureWorkflow.execute(payload))
          )
        ).toEqual({ outcome: "delivered" });
      }),
      30_000
    );

    it.effect(
      "does not arm after expiry while waiting for the exchange lock",
      Effect.fn(function* () {
        expect.assertions(2);
        const payload = yield* admit("+573007774676");
        const calls = yield* Ref.make(0);
        const provider: KapsoClientService = {
          sendText: () =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              return delivered("wamid.expiry-lock-466", yield* DateTime.now);
            }),
        };
        const runtime = yield* acquireRuntime(44669, provider);
        const admin = yield* MigrationSqlClient;
        yield* admin`UPDATE pending_consent_exchanges SET created_at = now() - interval '24 hours' + interval '1 second', expires_at = now() + interval '1 second' WHERE id = ${payload.exchangeId}`;
        const finished = yield* Deferred.make<void>();
        yield* lockConsentDisclosure(
          payload.exchangeId,
          Effect.gen(function* () {
            // ManagedRuntime starts independently of this transaction, unlike an inherited SQL fiber.
            yield* Effect.tryPromise(() =>
              runtime.runPromise(
                performConsentDisclosureAttempt(
                  payload.exchangeId,
                  DisclosureDeliveryAttemptNumber.make(1)
                ).pipe(Effect.provideService(KapsoClient, provider))
              )
            ).pipe(
              Effect.tap(() => Deferred.succeed(finished, undefined)),
              Effect.forkScoped
            );
            yield* Effect.sleep("1100 millis");
          })
        );
        yield* Deferred.await(finished);
        expect(yield* Ref.get(calls)).toBe(0);
        expect(Option.isNone(yield* findConsentDisclosureDeliveryState(payload.exchangeId))).toBe(
          true
        );
      }),
      30_000
    );

    it.effect(
      "reads delivery and currentness coherently when a callback interleaves between queries",
      Effect.fn(function* () {
        expect.assertions(2);
        const payload = yield* admit("+573007774675");
        const provider: KapsoClientService = {
          sendText: () =>
            DateTime.now.pipe(Effect.map((now) => delivered("wamid.coherent-466", now))),
        };
        yield* performConsentDisclosureAttempt(
          payload.exchangeId,
          DisclosureDeliveryAttemptNumber.make(1)
        ).pipe(Effect.provideService(KapsoClient, provider));
        const attempt = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* Ref.make(true);
        const transformer: Statement.Transformer = (statement) =>
          Effect.gen(function* () {
            const [query, parameters] = statement.compile();
            if (
              query.includes("FROM fidy_find_whatsapp_disclosure_request") &&
              parameters.includes(payload.exchangeId) &&
              (yield* Ref.getAndSet(first, false))
            ) {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
            }
            return statement;
          });
        const runtime = yield* acquireRuntime(44668, provider, transformer);
        yield* Effect.tryPromise(() =>
          runtime.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
        );
        yield* Deferred.await(reached);
        const callbackDone = yield* Deferred.make<void>();
        const occurredAt = yield* DateTime.now;
        yield* applyConsentDisclosureLifecycle({
          outcome: "accepted",
          correlationToken: DisclosureDeliveryCorrelationToken.make(attempt.attemptId),
          messageEvidence: delivered("wamid.coherent-466", occurredAt).messageEvidence,
          occurredAt,
        }).pipe(
          Effect.tap((outcome) => {
            expect(outcome).toBe("applied");
            return Deferred.succeed(callbackDone, undefined);
          }),
          Effect.forkScoped
        );
        const admin = yield* MigrationSqlClient;
        const callbackBlocked = Effect.gen(function* () {
          while (true) {
            const waiting =
              yield* admin`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%fidy_lock_whatsapp_disclosure%'`;
            if (waiting.length > 0) return;
            yield* Effect.sleep("10 millis");
          }
        });
        yield* Effect.race(Deferred.await(callbackDone), callbackBlocked);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(callbackDone);
        expect(
          yield* Effect.tryPromise(() =>
            runtime.runPromise(ConsentDisclosureWorkflow.execute(payload))
          )
        ).toEqual({ outcome: "delivered" });
      }),
      30_000
    );
  }
);
