import { expect, layer } from "@effect/vitest";
import {
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "effect/unstable/workflow";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { PgLive } from "~/shell/db/client";
import { findPendingConsentExchange, removePendingConsentExchange } from "~/shell/consent/repo";
import { handleOnboardingTurn } from "~/shell/onboarding/onboarding";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { ApiHarness } from "~/shell/testing/api-harness";
import { clusterTestSharedOptions } from "~/shell/testing/cluster-topology-fixtures";
import { resetClusterTopologyBeforeAll } from "~/shell/testing/cluster-topology-reset";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import {
  ConsentDisclosureWorkflowLive,
  applyConsentDisclosureLifecycle,
  performConsentDisclosureAttempt,
  requestConsentDisclosureDelivery,
  startNextConsentDisclosureEvidence,
} from "./disclosure-delivery";
import { DisclosureDeliveryAttemptNumber, disclosureActivityAttempt } from "./disclosure-model";
import {
  armConsentDisclosureAttempt,
  findConsentDisclosureDeliveryState,
} from "./disclosure-store";
import { ConsentDisclosureWorkflow } from "./disclosure-workflow";
import { KapsoClient, type KapsoClientService } from "./kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

const admit = Effect.fn(function* () {
  const caller = testWhatsAppCaller(E164PhoneNumber.make("+573007774689"));
  const previous = yield* findPendingConsentExchange(caller);
  if (Option.isSome(previous)) yield* removePendingConsentExchange(previous.value.id);
  const crypto = yield* Crypto.Crypto;
  const message = WhatsAppMessageEvidence.make({
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(`wamid.race-${yield* crypto.randomUUIDv4}`),
  });
  const now = yield* DateTime.now;
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
  registration: typeof ConsentDisclosureWorkflowLive
) {
  const crypto = yield* Crypto.Crypto;
  const runtimeLayer = registration.pipe(
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql(Redacted.make("c".repeat(64)), {
            runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            ...clusterTestSharedOptions,
            entityMessagePollInterval: 25,
            sendRetryInterval: 25,
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

const makeProvider = Effect.fn(function* (
  payload: typeof ConsentDisclosureWorkflow.payloadSchema.Type
) {
  const calls = yield* Ref.make(0);
  const firstSend = yield* Deferred.make<Parameters<typeof applyConsentDisclosureLifecycle>[0]>();
  const secondSend = yield* Deferred.make<void>();
  const provider: KapsoClientService = {
    sendText: (input) =>
      Effect.gen(function* () {
        const ordinal = yield* Ref.updateAndGet(calls, (count) => count + 1);
        const sentAt = yield* DateTime.now;
        const messageEvidence = WhatsAppMessageEvidence.make({
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: WhatsAppProviderMessageId.make(
            `wamid.noop-${payload.exchangeId}-${ordinal}`
          ),
        });
        if (ordinal === 1) {
          yield* Deferred.succeed(firstSend, {
            outcome: "accepted",
            correlationToken: yield* Effect.fromOption(input.opaqueCallbackData).pipe(Effect.orDie),
            messageEvidence,
            occurredAt: sentAt,
          });
        }
        if (ordinal === 2) yield* Deferred.succeed(secondSend, undefined);
        return { messageEvidence, sentAt, responseStatus: TelemetryHttpStatus.make(200) };
      }),
  };

  return { calls, firstSend, secondSend, provider };
});

const primeRegistration = (
  payload: typeof ConsentDisclosureWorkflow.payloadSchema.Type,
  primed: Deferred.Deferred<number>
): typeof ConsentDisclosureWorkflowLive =>
  ConsentDisclosureWorkflow.toLayer(
    Effect.fn(function* () {
      yield* performConsentDisclosureAttempt(
        payload.exchangeId,
        DisclosureDeliveryAttemptNumber.make(1)
      );
      const previous = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.orDie
      );
      expect(previous.state).toBe("reconciliation-required");
      // Both calls use the real arming gateway, which must decline ordinal two while acceptance is
      // ambiguous. Recording acceptance advanced the revision, so the stale-revision identity
      // differs from the ordinal-only identity; newer failure evidence must make production derive
      // a third, fresh identity and use neither cached no-op.
      const ordinalOnlyIdentity = 2;
      const staleRevisionIdentity = disclosureActivityAttempt(previous.evidenceRevision)(
        DisclosureDeliveryAttemptNumber.make(2)
      );
      expect(staleRevisionIdentity).not.toBe(ordinalOnlyIdentity);
      for (const primedIdentity of [ordinalOnlyIdentity, staleRevisionIdentity]) {
        yield* Activity.make({
          name: "Send",
          success: Schema.Void,
          execute: performConsentDisclosureAttempt(
            payload.exchangeId,
            DisclosureDeliveryAttemptNumber.make(2),
            Option.some(previous.evidenceRevision)
          ),
        }).pipe(Effect.provideService(Activity.CurrentAttempt, primedIdentity));
      }
      yield* Deferred.succeed(primed, previous.evidenceRevision);
      yield* DurableDeferred.await(DurableDeferred.make("PrimedNoop"));
      return { outcome: "not-current" as const };
    })
  );

const primeAndSuspend = Effect.fn(function* (
  payload: typeof ConsentDisclosureWorkflow.payloadSchema.Type,
  provider: KapsoClientService
) {
  const primed = yield* Deferred.make<number>();
  const first = yield* acquireRuntime(24689, provider, primeRegistration(payload, primed));
  yield* Effect.tryPromise(() =>
    first.runPromise(ConsentDisclosureWorkflow.execute(payload, { discard: true }))
  );
  const revision = yield* Deferred.await(primed);
  const executionId = yield* ConsentDisclosureWorkflow.executionId(payload);
  yield* Effect.tryPromise(() =>
    first.runPromise(
      Effect.gen(function* () {
        for (;;) {
          const result = yield* ConsentDisclosureWorkflow.poll(executionId);
          if (Option.isSome(result) && result.value._tag === "Suspended") return;
          yield* Effect.sleep("20 millis");
        }
      }).pipe(Effect.timeout("5 seconds"))
    )
  );
  yield* Effect.tryPromise(() => first.dispose());

  return { revision, executionId };
});

const RetryDelay = Workflow.make("TestDisclosureEvidenceRetryDelay", {
  payload: Schema.Struct({ exchangeId: PendingConsentExchangeId, evidenceRevision: Schema.Int }),
  success: Schema.Void,
  idempotencyKey: ({ exchangeId, evidenceRevision }) => `${exchangeId}/${evidenceRevision}`,
});
const RetryDelayLive = RetryDelay.toLayer(() =>
  DurableClock.sleep({ name: "RetryDelay", duration: "25 millis" })
);

const replaceFailureEvidence = Effect.fn(function* (
  accepted: Parameters<typeof applyConsentDisclosureLifecycle>[0],
  millisecondsAfterAcceptance: number
) {
  const sentAt = DateTime.add(accepted.occurredAt, {
    milliseconds: millisecondsAfterAcceptance,
  });
  expect(
    yield* applyConsentDisclosureLifecycle({
      ...accepted,
      outcome: "sent",
      occurredAt: sentAt,
    })
  ).toBe("applied");
  expect(
    yield* applyConsentDisclosureLifecycle({
      ...accepted,
      outcome: "failed",
      reason: "provider_unavailable",
      automaticRetry: true,
      occurredAt: DateTime.add(sentAt, { milliseconds: 1 }),
    })
  ).toBe("applied");
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "disclosure evidence races",
  (it) => {
    resetClusterTopologyBeforeAll();

    it.effect(
      "newer failure evidence reopens ordinal two despite an earlier cached no-op Activity",
      Effect.fn(function* () {
        const payload = yield* admit();
        const { calls, firstSend, secondSend, provider } = yield* makeProvider(payload);
        const { revision, executionId } = yield* primeAndSuspend(payload, provider);
        expect(yield* Ref.get(calls)).toBe(1);
        const accepted = yield* Deferred.await(firstSend);
        expect(
          yield* applyConsentDisclosureLifecycle({
            ...accepted,
            outcome: "failed",
            reason: "provider_unavailable",
            automaticRetry: true,
            occurredAt: DateTime.add(accepted.occurredAt, { milliseconds: 1 }),
          })
        ).toBe("applied");
        const failed = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        expect(failed.evidenceRevision).toBeGreaterThan(revision);
        expect(failed.state).toBe("definitively-failed");
        const recovered = yield* acquireRuntime(24690, provider, ConsentDisclosureWorkflowLive);
        yield* Effect.tryPromise(() =>
          recovered.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                yield* startNextConsentDisclosureEvidence().pipe(Effect.forever, Effect.forkScoped);
                const engine = yield* WorkflowEngine.WorkflowEngine;
                yield* engine.resume(ConsentDisclosureWorkflow, executionId);
                yield* Deferred.await(secondSend).pipe(Effect.timeout("10 seconds"));
              })
            )
          )
        );
        expect(yield* Ref.get(calls)).toBe(2);
        const latest = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        expect(latest.attemptNumber).toBe(2);
      })
    );
    it.effect(
      "an elapsed retry clock cannot arm against newer evidence without its renewed delay",
      Effect.fn(function* () {
        const payload = yield* admit();
        const one = DisclosureDeliveryAttemptNumber.make(1);
        const two = DisclosureDeliveryAttemptNumber.make(2);
        expect(
          Option.isNone(
            yield* armConsentDisclosureAttempt({
              exchangeId: payload.exchangeId,
              attemptNumber: one,
              now: yield* DateTime.now,
              expectedEvidenceRevision: Option.some(0),
            })
          )
        ).toBe(true);
        const { provider, firstSend } = yield* makeProvider(payload);
        yield* performConsentDisclosureAttempt(payload.exchangeId, one).pipe(
          Effect.provideService(KapsoClient, provider)
        );
        const accepted = yield* Deferred.await(firstSend);
        yield* replaceFailureEvidence(accepted, 1);
        const original = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        const runtime = yield* acquireRuntime(24691, provider, RetryDelayLive);
        yield* Effect.tryPromise(() =>
          runtime.runPromise(
            RetryDelay.execute({
              exchangeId: payload.exchangeId,
              evidenceRevision: original.evidenceRevision,
            })
          )
        );
        yield* replaceFailureEvidence(accepted, 3);
        const changed = yield* findConsentDisclosureDeliveryState(payload.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        expect(changed.evidenceRevision).toBeGreaterThan(original.evidenceRevision);
        expect(changed.state).toBe("definitively-failed");
        expect(
          Option.isNone(
            yield* armConsentDisclosureAttempt({
              exchangeId: payload.exchangeId,
              attemptNumber: two,
              now: yield* DateTime.now,
              expectedEvidenceRevision: Option.some(original.evidenceRevision),
            })
          )
        ).toBe(true);
        expect(
          Option.isNone(
            yield* armConsentDisclosureAttempt({
              exchangeId: payload.exchangeId,
              attemptNumber: two,
              now: yield* DateTime.now,
              expectedEvidenceRevision: Option.none(),
            })
          )
        ).toBe(true);
        expect(yield* findConsentDisclosureDeliveryState(payload.exchangeId)).toEqual(
          Option.some(changed)
        );
        yield* Effect.tryPromise(() =>
          runtime.runPromise(
            RetryDelay.execute({
              exchangeId: payload.exchangeId,
              evidenceRevision: changed.evidenceRevision,
            })
          )
        );
        const armed = yield* armConsentDisclosureAttempt({
          exchangeId: payload.exchangeId,
          attemptNumber: two,
          now: yield* DateTime.now,
          expectedEvidenceRevision: Option.some(changed.evidenceRevision),
        });
        expect(Option.map(armed, (attempt) => attempt.attemptNumber)).toEqual(Option.some(two));
      })
    );
  }
);
