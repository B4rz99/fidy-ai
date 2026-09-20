import { expect, layer } from "@effect/vitest";
import {
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ClusterWorkflowEngine } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import {
  BrowserPairingEmailStartRequestId,
  BrowserPairingEmailWorkflowId,
  EmailAddress,
  EmailDeliveryIntentId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { TelemetryDisabled } from "~/shell/observability/operations";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "~/shell/testing/telemetry-harness";
import { loopbackClusterRunnerHttpPolicy } from "~/shell/testing/cluster-runner-http-policy";
import { MigrationSqlClient, PgLive } from "~/shell/testing/database-harness";
import { seedConsentedPatIdentity } from "~/shell/testing/development-seed";
import { clusterMessagesTable, clusterRepliesTable } from "~/shell/durable-tables";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  clusterTestRunnerOptions,
  clusterTestShardLockExpiration,
  clusterTestShardLockRefreshInterval,
} from "~/shell/testing/cluster-topology-fixtures";
import { availableLoopbackPort } from "~/shell/testing/network";
import { eventually } from "~/shell/testing/eventually";
import { deriveEmailCredentialLookupKey } from "~/shell/secret-material/operations";
import {
  BrowserPairingEmailWorkflowLive,
  pairingQueueHandlerPolicy,
  processPairingDeliveryQueueItem,
  processPairingExpiryQueueItem,
  processPairingStartQueueItem,
} from "./authentication-delivery-worker";
import { EmailDeliveryPort, type EmailDeliveryPortService, EmailSendFailed } from "./delivery";
import {
  BrowserPairingEmailDeliveryWorkflow,
  BrowserPairingEmailExpiryWorkflow,
  PairingDeliveryPayload,
  PairingExpiryPayload,
  pairingDeliveryQueue,
  pairingExpiryQueue,
  pairingStartQueue,
  publishPairingDelivery,
} from "./pairing-email-execution";
import { SqlClient } from "effect/unstable/sql";
import { purgeBrowserPairingEmailExecutionHistory } from "./authentication-retention";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000463");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000464");
const bearer = TokenBearer.make("fin_login463_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const email = EmailAddress.make("workflow-463@example.com");

const hasRows = (rows: ReadonlyArray<unknown>): boolean => rows.length > 0;
const isSuspended = (state: Option.Option<{ readonly _tag: string }>): boolean =>
  Option.exists(state, (value) => value._tag === "Suspended");

const requestStart = Effect.fn(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name IN ('browser-pairing-email-start', 'browser-pairing-email-delivery', 'browser-pairing-email-expiry')`;
  yield* sql`DELETE FROM browser_pairing_email_start_requests`;
  yield* sql`DELETE FROM browser_pairing_email_workflows`;
  yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
  yield* sql`DELETE FROM email_delivery_admission_budgets`;
  yield* sql`DELETE FROM browser_login_start_attempts`;
  yield* seedConsentedPatIdentity({ userId, bearer });
  const lookup = yield* deriveEmailCredentialLookupKey(email);
  yield* sql`UPDATE verified_email_credentials SET email_address = ${email}, verified_at = ${yield* DateTime.now} WHERE user_id = ${userId}`;
  yield* sql`INSERT INTO verified_email_credential_authentication_lookups (user_id, authentication_lookup_key)
    VALUES (${userId}, ${lookup}) ON CONFLICT (user_id) DO UPDATE SET authentication_lookup_key = EXCLUDED.authentication_lookup_key`;
  const pairing = yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(
    yield* (yield* HttpClient.post("/web/pairings")).json
  );
  const response = yield* HttpClient.post("/web/email/authentication/start", {
    headers: {
      origin: "https://fidyapp.com",
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.163",
    },
    body: HttpBody.jsonUnsafe({
      pairingId: pairing.pairingId,
      privateVerifier: Redacted.value(pairing.privateVerifier),
      email,
    }),
  });
  expect(response.status).toBe(202);
  return pairing;
});

const startQueueFailureFixture = Effect.fn(function* () {
  const pairing = yield* requestStart();
  const sql = yield* MigrationSqlClient;
  const queued = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ requestId: BrowserPairingEmailStartRequestId }))
  )(
    yield* sql`SELECT id AS "requestId" FROM browser_pairing_email_start_requests
      WHERE pairing_id = ${pairing.pairingId}`
  );
  const payload = queued[0];
  if (payload === undefined) return yield* Effect.die("expected queued start request");
  const telemetry = yield* Layer.build(TelemetryEnvelopeRecording);
  const recorder = Context.get(telemetry, EnvelopeRecorder);
  const logs: Array<string> = [];
  const logger = Logger.make((options) => logs.push(Bun.inspect(options)));
  return { pairing, payload, telemetry, recorder, logs, logger };
});

const admit = Effect.fn(function* () {
  const sql = yield* MigrationSqlClient;
  const pairing = yield* requestStart();
  const queue = pairingStartQueue;
  yield* queue.handleNext(processPairingStartQueueItem, pairingQueueHandlerPolicy).pipe(
    // This focused helper owns disabled telemetry for the sanitized consumer boundary.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(TelemetryDisabled)
  );
  const payloads = yield* Schema.decodeUnknownEffect(Schema.Array(PairingDeliveryPayload))(
    yield* sql`SELECT 1 AS revision, intent.id AS "intentId", workflow.user_id AS "userId"
      FROM browser_pairing_email_delivery_intents intent JOIN browser_pairing_email_workflows workflow ON workflow.id = intent.workflow_id
      WHERE workflow.pairing_id = ${pairing.pairingId}`
  );
  const payload = payloads[0];
  if (payload === undefined) return yield* Effect.die("expected accepted delivery");
  return { payload, pairing };
});

const runtimeFor = Effect.fn(function* (provider: EmailDeliveryPortService) {
  const crypto = yield* Crypto.Crypto;
  const port = yield* availableLoopbackPort;
  const cluster = authenticatedClusterHttp.layerSql(
    Redacted.make("c".repeat(64)),
    clusterTestRunnerOptions({
      port,
      overrides: {
        runnerHealthCheckInterval: 100,
        refreshAssignmentsInterval: 100,
        shardLockRefreshInterval: clusterTestShardLockRefreshInterval,
        shardLockExpiration: clusterTestShardLockExpiration,
      },
    }),
    loopbackClusterRunnerHttpPolicy([port])
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() =>
      ManagedRuntime.make(
        BrowserPairingEmailWorkflowLive.pipe(
          Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster))),
          Layer.provideMerge(PgLive),
          Layer.provide(Layer.succeed(EmailDeliveryPort, provider)),
          Layer.provide(Layer.succeed(Crypto.Crypto, crypto))
        )
      )
    ),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
  yield* Effect.tryPromise(() => runtime.context());
  return runtime;
});

const killAtBoundary = Effect.fn(function* (
  mode: "before-send" | "after-send" | "expiry",
  owner: UserId,
  identity: string
) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        ["bun", "src/shell/testing/pairing-workflow-crash-runner.ts", mode, owner, identity],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }
      )
    ),
    (runner) =>
      Effect.sync(() => {
        runner.kill("SIGKILL");
      }).pipe(Effect.andThen(Effect.tryPromise(() => runner.exited)), Effect.orDie)
  );
  const output = yield* Stream.fromReadableStream({
    evaluate: () => child.stdout,
    onError: () => "crash-runner-output-failed" as const,
  }).pipe(
    Stream.decodeText(),
    Stream.scanEffect("", (text, chunk) =>
      text.length + chunk.length > 16_384
        ? Effect.die("crash runner output exceeded bound")
        : Effect.succeed(text + chunk)
    ),
    Stream.takeUntil((text) => text.includes("crash-boundary-ready")),
    Stream.runLast,
    Effect.timeout("15 seconds")
  );
  if (Option.isNone(output) || !output.value.includes("crash-boundary-ready")) {
    return yield* Effect.die("crash runner exited before boundary");
  }
  child.kill("SIGKILL");
  yield* Effect.tryPromise(() => child.exited);
  return output.value;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "SQL browser-pairing email workflows",
  (it) => {
    it.effect.each(["before-send", "after-send"] as const)(
      "recovers abrupt process death at %s without another provider effect",
      (mode) =>
        Effect.gen(function* () {
          const { payload, pairing } = yield* admit();
          const output = yield* killAtBoundary(mode, payload.userId, payload.intentId);
          expect(output.includes("provider-accepted")).toBe(mode === "after-send");
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM browser_pairing_email_delivery_intents WHERE id = ${payload.intentId}`
          ).toEqual([{ status: "armed" }]);
          const runtime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () => Effect.die("Armed hard-loss recovery must not send"),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "uncertain" });
          expect(
            yield* sql`SELECT lifecycle FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
          ).toEqual([{ lifecycle: "pending_approval" }]);
        }),
      30_000
    );

    it.effect(
      "coordinates duplicate delivery across independently scoped SQL runtimes",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const sends = yield* Ref.make(0);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const provider = EmailDeliveryPort.of({
            send: () =>
              Ref.update(sends, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release))
              ),
          });
          const firstRuntime = yield* runtimeFor(provider);
          const replacementRuntime = yield* runtimeFor(provider);
          const executions = yield* Effect.tryPromise(() =>
            Promise.all([
              firstRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload)),
              replacementRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload)),
            ])
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(executions)).toEqual([{ outcome: "sent" }, { outcome: "sent" }]);
          expect(yield* Ref.get(sends)).toBe(1);
        }),
      30_000
    );

    it.effect(
      "recovers a possibly accepted send as uncertain without sending or approving again",
      () =>
        Effect.gen(function* () {
          const { payload, pairing } = yield* admit();
          const sends = yield* Ref.make(0);
          const accepted = yield* Deferred.make<void>();
          const firstRuntime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(sends, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(accepted, undefined)),
                  Effect.andThen(Effect.never)
                ),
            })
          );
          yield* Effect.tryPromise(() =>
            firstRuntime.runPromise(
              BrowserPairingEmailDeliveryWorkflow.execute(payload, {
                discard: true,
              })
            )
          );
          yield* Deferred.await(accepted);
          yield* Effect.tryPromise(() => firstRuntime.dispose());
          const replacementRuntime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () => Ref.update(sends, (count) => count + 1),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              replacementRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "uncertain" });
          expect(yield* Ref.get(sends)).toBe(1);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT lifecycle FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
          ).toEqual([{ lifecycle: "pending_approval" }]);
        }),
      30_000
    );

    it.effect(
      "bounds temporary refusals to three durable attempts with distinct unrecoverable proofs",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const inputs = yield* Ref.make<
            ReadonlyArray<Parameters<EmailDeliveryPortService["send"]>[0]>
          >([]);
          const runtime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: (input) =>
                Ref.update(inputs, (values) => [...values, input]).pipe(
                  Effect.andThen(
                    new EmailSendFailed({
                      certainty: "rejected",
                      retryable: true,
                    })
                  )
                ),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "retry-exhausted" });
          const attempts = yield* Ref.get(inputs);
          expect(attempts).toHaveLength(3);
          expect(new Set(attempts.map((input) => input.combinedCode)).size).toBe(3);
          expect(new Set(attempts.map((input) => input.idempotencyKey)).size).toBe(3);
          // Native storage is an explicit security observer: no bearer-equivalent values may reach it.
          const sql = yield* MigrationSqlClient;
          const history = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            yield* sql`SELECT * FROM fidy_durable.${sql(clusterMessagesTable)}`
          );
          const replies = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            yield* sql`SELECT * FROM fidy_durable.${sql(clusterRepliesTable)}`
          );
          for (const input of attempts) {
            expect(history + replies).not.toContain(input.combinedCode);
            expect(history + replies).not.toContain(input.to);
          }
        }),
      30_000
    );

    it.effect(
      "stops after a permanent provider refusal and erases the unusable proof",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const sends = yield* Ref.make(0);
          const runtime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(sends, (count) => count + 1).pipe(
                  Effect.andThen(
                    new EmailSendFailed({
                      certainty: "rejected",
                      retryable: false,
                    })
                  )
                ),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "refused" });
          expect(yield* Ref.get(sends)).toBe(1);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT proof_digest, proof_expires_at FROM browser_pairing_email_workflows WHERE user_id = ${payload.userId}`
          ).toEqual([{ proof_digest: null, proof_expires_at: null }]);
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "refused" });
          expect(yield* Ref.get(sends)).toBe(1);
        }),
      30_000
    );

    it.effect(
      "resumes a confirmed temporary refusal after replacing its retrying runtime",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const inputs = yield* Ref.make<
            ReadonlyArray<Parameters<EmailDeliveryPortService["send"]>[0]>
          >([]);
          const firstRuntime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: (input) =>
                Ref.update(inputs, (values) => [...values, input]).pipe(
                  Effect.andThen(
                    new EmailSendFailed({
                      certainty: "rejected",
                      retryable: true,
                    })
                  )
                ),
            })
          );
          yield* Effect.tryPromise(() =>
            firstRuntime.runPromise(
              BrowserPairingEmailDeliveryWorkflow.execute(payload, {
                discard: true,
              })
            )
          );
          const sql = yield* MigrationSqlClient;
          yield* eventually(
            sql`SELECT id FROM browser_pairing_email_delivery_intents WHERE id = ${payload.intentId} AND status = 'temporarily-refused'`,
            (rows) => rows.length > 0,
            { interval: "5 millis", timeout: "5 seconds" }
          );
          yield* Effect.tryPromise(() => firstRuntime.dispose());
          const replacementRuntime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: (input) => Ref.update(inputs, (values) => [...values, input]),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              replacementRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "sent" });
          const attempts = yield* Ref.get(inputs);
          expect(attempts).toHaveLength(2);
          expect(new Set(attempts.map((input) => input.combinedCode)).size).toBe(2);
          yield* Effect.tryPromise(() => replacementRuntime.dispose());
          const replayRuntime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () => Effect.die("settled delivery must not replay"),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              replayRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "sent" });
        }),
      30_000
    );

    it.effect(
      "clears only completed delivery history after its replay horizon",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const runtime = yield* runtimeFor(EmailDeliveryPort.of({ send: () => Effect.void }));
          const queue = pairingDeliveryQueue;
          yield* queue.handleNext(
            (input) =>
              Effect.tryPromise(
                runtime.runPromise.bind(
                  runtime,
                  BrowserPairingEmailDeliveryWorkflow.execute(input),
                  undefined
                )
              ).pipe(Effect.orDie),
            pairingQueueHandlerPolicy
          );
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE fidy_durable.fidy_queue SET updated_at = now() - interval '25 hours' WHERE queue_name = 'browser-pairing-email-delivery' AND id = ${payload.intentId}`;
          yield* Effect.tryPromise(() =>
            runtime.runPromise(purgeBrowserPairingEmailExecutionHistory())
          );
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-delivery' AND id = ${payload.intentId}`
          ).toEqual([]);
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-expiry'`
          ).toHaveLength(1);
        }),
      30_000
    );

    it.effect(
      "drains bounded history pages without erasing a suspended expiry",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE browser_pairing_email_workflows SET expires_at = ${DateTime.add(yield* DateTime.now, { seconds: 10 })}
            WHERE user_id = ${payload.userId}`;
          const runtime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () => Effect.die("expiry must not send"),
            })
          );
          const queue = pairingExpiryQueue;
          const observedExpiry = yield* Ref.make(Option.none<PairingExpiryPayload>());
          yield* queue.handleNext(
            (input) =>
              Effect.tryPromise(
                runtime.runPromise.bind(
                  runtime,
                  BrowserPairingEmailExpiryWorkflow.execute(input, {
                    discard: true,
                  }),
                  undefined
                )
              ).pipe(Effect.orDie, Effect.andThen(Ref.set(observedExpiry, Option.some(input)))),
            pairingQueueHandlerPolicy
          );
          const expiry = yield* Ref.get(observedExpiry).pipe(Effect.flatMap(Effect.fromOption));
          const executionId = yield* BrowserPairingEmailExpiryWorkflow.executionId(expiry);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(
              eventually(BrowserPairingEmailExpiryWorkflow.poll(executionId), isSuspended, {
                interval: "25 millis",
                timeout: "5 seconds",
              })
            )
          );
          yield* sql`INSERT INTO fidy_durable.fidy_queue (id, queue_name, element, completed, created_at, updated_at)
            SELECT gen_random_uuid()::text, 'browser-pairing-email-start',
              jsonb_build_object('revision', 1, 'requestId', gen_random_uuid())::text, TRUE, now(), now()
            FROM generate_series(1, 100)`;
          yield* sql`UPDATE fidy_durable.fidy_queue SET updated_at = now() - interval '25 hours'
            WHERE queue_name IN ('browser-pairing-email-start', 'browser-pairing-email-expiry')`;
          const cursor = yield* Effect.tryPromise(() =>
            runtime.runPromise(purgeBrowserPairingEmailExecutionHistory())
          );
          expect(cursor).toBeGreaterThan(0);
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-start'`
          ).toHaveLength(2);
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(purgeBrowserPairingEmailExecutionHistory(cursor))
            )
          ).toBe(0);
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-start'`
          ).toEqual([]);
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-expiry'`
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT id FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId}`
          ).toHaveLength(1);
          yield* sql`UPDATE browser_pairing_email_workflows
            SET started_at = now() - interval '24 hours', expires_at = now() - interval '1 second'
            WHERE id = ${expiry.workflowId}`;
          const releasedClocks = yield* sql`UPDATE fidy_durable.${sql(clusterMessagesTable)}
            SET deliver_at = 0
            WHERE entity_id = ${executionId} AND processed = FALSE AND deliver_at IS NOT NULL
            RETURNING id`;
          expect(releasedClocks.length).toBeGreaterThan(0);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(BrowserPairingEmailExpiryWorkflow.execute(expiry))
          );
          expect(
            yield* sql`SELECT id FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(purgeBrowserPairingEmailExecutionHistory())
            )
          ).toBe(0);
          expect(
            yield* sql`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-expiry'`
          ).toEqual([]);
          expect(
            yield* sql`SELECT id FROM fidy_durable.${sql(clusterMessagesTable)} WHERE entity_id = ${executionId}`
          ).toEqual([]);
        }),
      30_000
    );

    it.effect(
      "refuses cross-User delivery payloads without consuming the rightful delivery",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const sends = yield* Ref.make(0);
          const runtime = yield* runtimeFor(
            EmailDeliveryPort.of({
              send: () => Ref.update(sends, (count) => count + 1),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(
                BrowserPairingEmailDeliveryWorkflow.execute({
                  ...payload,
                  userId: otherUserId,
                })
              )
            )
          ).toEqual({ outcome: "not-current" });
          expect(yield* Ref.get(sends)).toBe(0);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM browser_pairing_email_delivery_intents WHERE id = ${payload.intentId}`
          ).toEqual([{ status: "pending" }]);
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
            )
          ).toEqual({ outcome: "sent" });
          expect(yield* Ref.get(sends)).toBe(1);
        }),
      30_000
    );

    it.effect("stores only the stable retry marker for transient start database failures", () =>
      Effect.gen(function* () {
        const { pairing, payload, telemetry, recorder, logs, logger } =
          yield* startQueueFailureFixture();
        const sql = yield* MigrationSqlClient;

        yield* sql`CREATE OR REPLACE FUNCTION fidy_test_pairing_start_retry() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'sql-detail-sentinel provider-diagnostic-sentinel secret-sentinel'
              USING ERRCODE = '40001';
          END
        $$;
        CREATE TRIGGER fidy_test_pairing_start_retry BEFORE DELETE ON browser_pairing_email_start_requests
          FOR EACH ROW EXECUTE FUNCTION fidy_test_pairing_start_retry()`;
        const exit = yield* Effect.exit(
          pairingStartQueue
            .handleNext(processPairingStartQueueItem, pairingQueueHandlerPolicy)
            .pipe(Effect.provide(telemetry), Effect.withLogger(logger))
        ).pipe(
          Effect.ensuring(
            sql`DROP TRIGGER fidy_test_pairing_start_retry ON browser_pairing_email_start_requests;
              DROP FUNCTION fidy_test_pairing_start_retry()`.pipe(Effect.orDie)
          )
        );

        expect(Exit.isFailure(exit)).toBe(true);
        const rows = yield* sql`SELECT attempts, last_failure FROM fidy_durable.fidy_queue
          WHERE queue_name = 'browser-pairing-email-start' AND id = ${payload.requestId}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.attempts).toBe(1);
        expect(rows[0]?.last_failure).toContain('"reason":"transient"');
        expect(yield* recorder.serializedEnvelopes).toEqual([]);
        const observableText = [rows[0]?.last_failure, ...logs].join("\n");
        for (const sentinel of [
          payload.requestId,
          pairing.pairingId,
          pairing.publicCode,
          Redacted.value(pairing.privateVerifier),
          email,
          userId,
          "sql-detail-sentinel",
          "provider-diagnostic-sentinel",
          "secret-sentinel",
        ]) {
          expect(observableText).not.toContain(sentinel);
        }
      })
    );

    it.effect("observes one start defect and stores only the shared defect marker", () =>
      Effect.gen(function* () {
        const { pairing, payload, telemetry, recorder, logs, logger } =
          yield* startQueueFailureFixture();
        const sql = yield* MigrationSqlClient;

        yield* sql`CREATE OR REPLACE FUNCTION fidy_test_pairing_start_defect() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'sql-defect-sentinel provider-defect-sentinel secret-defect-sentinel'
              USING ERRCODE = '23514';
          END
        $$;
        CREATE TRIGGER fidy_test_pairing_start_defect BEFORE DELETE ON browser_pairing_email_start_requests
          FOR EACH ROW EXECUTE FUNCTION fidy_test_pairing_start_defect()`;
        const exit = yield* Effect.exit(
          pairingStartQueue
            .handleNext(processPairingStartQueueItem, pairingQueueHandlerPolicy)
            .pipe(Effect.provide(telemetry), Effect.withLogger(logger))
        ).pipe(
          Effect.ensuring(
            sql`DROP TRIGGER fidy_test_pairing_start_defect ON browser_pairing_email_start_requests;
              DROP FUNCTION fidy_test_pairing_start_defect()`.pipe(Effect.orDie)
          )
        );

        expect(Exit.isFailure(exit)).toBe(true);
        const rows = yield* sql`SELECT attempts, last_failure FROM fidy_durable.fidy_queue
          WHERE queue_name = 'browser-pairing-email-start' AND id = ${payload.requestId}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.attempts).toBe(1);
        expect(rows[0]?.last_failure).toContain('"reason":"unexpected-defect"');
        const envelopes = yield* recorder.serializedEnvelopes;
        expect(envelopes).toHaveLength(1);
        const observableText = [
          rows[0]?.last_failure,
          ...envelopes.map((bytes) => new TextDecoder().decode(bytes)),
          ...logs,
        ].join("\n");
        for (const sentinel of [
          payload.requestId,
          pairing.pairingId,
          pairing.publicCode,
          Redacted.value(pairing.privateVerifier),
          email,
          userId,
          "sql-defect-sentinel",
          "provider-defect-sentinel",
          "secret-defect-sentinel",
        ]) {
          expect(observableText).not.toContain(sentinel);
        }
      })
    );

    it.effect("redacts unexpected delivery and expiry submission defects", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name IN ('browser-pairing-email-delivery', 'browser-pairing-email-expiry')`;
        const delivery = pairingDeliveryQueue;
        const expiry = pairingExpiryQueue;
        const deliveryPayload = PairingDeliveryPayload.make({
          revision: 1,
          userId,
          intentId: EmailDeliveryIntentId.make("f1d1a000-0000-4000-8000-000000000468"),
        });
        const expiryPayload = PairingExpiryPayload.make({
          revision: 1,
          userId,
          workflowId: BrowserPairingEmailWorkflowId.make("f1d1a000-0000-4000-8000-000000000469"),
        });
        yield* delivery.offer(deliveryPayload, {
          id: deliveryPayload.intentId,
        });
        yield* expiry.offer(expiryPayload, { id: expiryPayload.workflowId });

        const telemetry = yield* Layer.build(TelemetryEnvelopeRecording);
        const recorder = Context.get(telemetry, EnvelopeRecorder);
        const logs: Array<string> = [];
        const logger = Logger.make((options) => logs.push(Bun.inspect(options)));
        const engine = yield* WorkflowEngine.WorkflowEngine;
        const defectingEngine = WorkflowEngine.WorkflowEngine.of({
          ...engine,
          execute: () =>
            Effect.die(
              new Error(
                `provider-defect-sentinel secret-defect-sentinel proof-defect-sentinel ${email} ${userId}`
              )
            ),
        });

        const exits = yield* Effect.all(
          [
            Effect.exit(
              delivery.handleNext(processPairingDeliveryQueueItem, pairingQueueHandlerPolicy)
            ),
            Effect.exit(
              expiry.handleNext(processPairingExpiryQueueItem, pairingQueueHandlerPolicy)
            ),
          ],
          { concurrency: 1 }
        ).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, defectingEngine),
          Effect.provide(telemetry),
          Effect.withLogger(logger)
        );

        expect(exits.every(Exit.isFailure)).toBe(true);
        const rows = yield* sql`SELECT queue_name, attempts, last_failure
          FROM fidy_durable.fidy_queue
          WHERE id IN (${deliveryPayload.intentId}, ${expiryPayload.workflowId})
          ORDER BY queue_name`;
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.queue_name)).toEqual([
          "browser-pairing-email-delivery",
          "browser-pairing-email-expiry",
        ]);
        expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
        expect(rows[0]?.last_failure).toContain('"reason":"unexpected-defect"');
        expect(rows[1]?.last_failure).toContain('"reason":"unexpected-defect"');
        const envelopes = yield* recorder.serializedEnvelopes;
        expect(envelopes).toHaveLength(2);
        const observableText = [
          ...rows.map((row) => String(row.last_failure)),
          ...envelopes.map((bytes) => new TextDecoder().decode(bytes)),
          ...logs,
        ].join("\n");
        for (const sentinel of [
          deliveryPayload.intentId,
          expiryPayload.workflowId,
          email,
          userId,
          "provider-defect-sentinel",
          "secret-defect-sentinel",
          "proof-defect-sentinel",
        ]) {
          expect(observableText).not.toContain(sentinel);
        }
      })
    );

    it.effect("releases interrupted start work without consuming an attempt", () =>
      Effect.gen(function* () {
        const pairing = yield* requestStart();
        const sql = yield* MigrationSqlClient;
        const queued = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ requestId: BrowserPairingEmailStartRequestId }))
        )(
          yield* sql`SELECT id AS "requestId" FROM browser_pairing_email_start_requests
            WHERE pairing_id = ${pairing.pairingId}`
        );
        const payload = queued[0];
        if (payload === undefined) return yield* Effect.die("expected queued start request");

        yield* sql`CREATE OR REPLACE FUNCTION fidy_test_pairing_start_pause() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_sleep(30);
            RETURN OLD;
          END
        $$;
        CREATE TRIGGER fidy_test_pairing_start_pause BEFORE DELETE ON browser_pairing_email_start_requests
          FOR EACH ROW EXECUTE FUNCTION fidy_test_pairing_start_pause()`;
        yield* Effect.gen(function* () {
          const fiber = yield* pairingStartQueue
            .handleNext(processPairingStartQueueItem, pairingQueueHandlerPolicy)
            .pipe(
              // The test owns the disabled telemetry lifetime around the interrupted consumer.
              // @effect-diagnostics-next-line strictEffectProvide:off
              Effect.provide(TelemetryDisabled),
              Effect.forkChild
            );
          yield* eventually(
            sql`SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event = 'PgSleep'
              AND query LIKE '%browser_pairing_email_start_requests%'`,
            hasRows,
            { interval: "10 millis", timeout: "5 seconds" }
          );
          yield* Fiber.interrupt(fiber);
        }).pipe(
          Effect.ensuring(
            sql`DROP TRIGGER fidy_test_pairing_start_pause ON browser_pairing_email_start_requests;
              DROP FUNCTION fidy_test_pairing_start_pause()`.pipe(Effect.orDie)
          )
        );

        expect(
          yield* sql`SELECT attempts, last_failure FROM fidy_durable.fidy_queue
            WHERE queue_name = 'browser-pairing-email-start' AND id = ${payload.requestId}`
        ).toEqual([{ attempts: 0, last_failure: null }]);
      })
    );

    it.effect("completes stale work through every sanitized queue consumer", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name IN ('browser-pairing-email-start', 'browser-pairing-email-delivery', 'browser-pairing-email-expiry')`;
        const start = pairingStartQueue;
        const delivery = pairingDeliveryQueue;
        const expiry = pairingExpiryQueue;
        const startPayload = {
          revision: 1 as const,
          requestId: BrowserPairingEmailStartRequestId.make("f1d1a000-0000-4000-8000-000000000465"),
        };
        const deliveryPayload = PairingDeliveryPayload.make({
          revision: 1,
          userId,
          intentId: EmailDeliveryIntentId.make("f1d1a000-0000-4000-8000-000000000466"),
        });
        const expiryPayload = PairingExpiryPayload.make({
          revision: 1,
          userId,
          workflowId: BrowserPairingEmailWorkflowId.make("f1d1a000-0000-4000-8000-000000000467"),
        });
        yield* start.offer(startPayload, { id: startPayload.requestId });
        yield* delivery.offer(deliveryPayload, {
          id: deliveryPayload.intentId,
        });
        yield* expiry.offer(expiryPayload, { id: expiryPayload.workflowId });

        yield* Effect.all(
          [
            start.handleNext(processPairingStartQueueItem, pairingQueueHandlerPolicy),
            delivery.handleNext(processPairingDeliveryQueueItem, pairingQueueHandlerPolicy),
            expiry.handleNext(processPairingExpiryQueueItem, pairingQueueHandlerPolicy),
          ],
          { concurrency: 1 }
        ).pipe(
          // This focused consumer test owns the workflow registration and disabled telemetry scope.
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(Layer.merge(BrowserPairingEmailWorkflowLive, TelemetryDisabled)),
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: () => Effect.die("stale work must not send"),
            })
          )
        );

        expect(
          yield* sql`SELECT queue_name, completed, attempts, last_failure
            FROM fidy_durable.fidy_queue
            WHERE id IN (${startPayload.requestId}, ${deliveryPayload.intentId}, ${expiryPayload.workflowId})
            ORDER BY queue_name`
        ).toEqual([
          {
            queue_name: "browser-pairing-email-delivery",
            completed: true,
            attempts: 1,
            last_failure: null,
          },
          {
            queue_name: "browser-pairing-email-expiry",
            completed: true,
            attempts: 1,
            last_failure: null,
          },
          {
            queue_name: "browser-pairing-email-start",
            completed: true,
            attempts: 1,
            last_failure: null,
          },
        ]);
      })
    );

    it.effect("rolls back native publication with its enclosing transaction", () =>
      Effect.gen(function* () {
        const { payload } = yield* admit();
        const migration = yield* MigrationSqlClient;
        yield* migration`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-delivery' AND id = ${payload.intentId}`;
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            publishPairingDelivery(payload).pipe(Effect.andThen(Effect.fail("rollback")))
          )
          .pipe(Effect.ignore);
        expect(
          yield* migration`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-delivery' AND id = ${payload.intentId}`
        ).toEqual([]);
        yield* publishPairingDelivery(payload);
        yield* publishPairingDelivery(payload);
        expect(
          yield* migration`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'browser-pairing-email-delivery' AND id = ${payload.intentId}`
        ).toHaveLength(1);
      })
    );

    it.effect(
      "refuses cross-User expiry without erasing proof or poisoning rightful expiry",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          yield* seedConsentedPatIdentity({
            userId: otherUserId,
            bearer: TokenBearer.make("fin_login464_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
          });
          const runtime = yield* runtimeFor(EmailDeliveryPort.of({ send: () => Effect.void }));
          yield* Effect.tryPromise(() =>
            runtime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload))
          );
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE browser_pairing_email_workflows SET started_at = now() - interval '2 seconds',
            expires_at = now() - interval '1 second', proof_expires_at = now() - interval '1 second'
            WHERE user_id = ${payload.userId}`;
          const expiries = yield* Schema.decodeUnknownEffect(Schema.Array(PairingExpiryPayload))(
            yield* sql`SELECT 1 AS revision, id AS "workflowId", user_id AS "userId" FROM browser_pairing_email_workflows WHERE user_id = ${payload.userId}`
          );
          const expiry = expiries[0];
          if (expiry === undefined) return yield* Effect.die("expected expiry");
          const proof =
            yield* sql`SELECT proof_digest FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId} AND proof_digest IS NOT NULL`;
          expect(proof).toHaveLength(1);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(
              BrowserPairingEmailExpiryWorkflow.execute({
                ...expiry,
                userId: otherUserId,
              })
            )
          );
          expect(
            yield* sql`SELECT proof_digest FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual(proof);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(BrowserPairingEmailExpiryWorkflow.execute(expiry))
          );
          expect(
            yield* sql`SELECT id FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
        }),
      30_000
    );

    it.effect(
      "expires proof state after killing the process that scheduled its durable deadline",
      () =>
        Effect.gen(function* () {
          const { payload } = yield* admit();
          const sql = yield* MigrationSqlClient;
          const deadline = DateTime.add(yield* DateTime.now, { seconds: 5 });
          yield* sql`UPDATE browser_pairing_email_workflows SET expires_at = ${deadline} WHERE user_id = ${payload.userId}`;
          const expiries = yield* Schema.decodeUnknownEffect(Schema.Array(PairingExpiryPayload))(
            yield* sql`SELECT 1 AS revision, id AS "workflowId", user_id AS "userId" FROM browser_pairing_email_workflows WHERE user_id = ${payload.userId}`
          );
          const expiry = expiries[0];
          if (expiry === undefined) return yield* Effect.die("expected expiry");
          const provider = EmailDeliveryPort.of({
            send: () => Effect.die("expiry must not send"),
          });
          yield* killAtBoundary("expiry", expiry.userId, expiry.workflowId);
          const replacementRuntime = yield* runtimeFor(provider);
          yield* Effect.tryPromise(() =>
            replacementRuntime.runPromise(BrowserPairingEmailExpiryWorkflow.execute(expiry))
          );
          expect(
            yield* sql`SELECT id FROM browser_pairing_email_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
        }),
      30_000
    );
  }
);
