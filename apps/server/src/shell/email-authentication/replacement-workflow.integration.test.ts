import { expect, layer } from "@effect/vitest";
import {
  Cause,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  type Layer,
  Logger,
  ManagedRuntime,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { SqlError } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { EmailAddress } from "~/core/email-authentication/model";
import { TokenBearer } from "~/core/tokens/model";
import { MigrationSqlClient } from "~/shell/testing/database-harness";
import { seedConsentedPatIdentity } from "~/shell/testing/development-seed";
import { clusterMessagesTable, clusterRepliesTable } from "~/shell/durable-tables";
import { withUserTransaction } from "~/shell/database/operations";
import { EnvelopeRecorder } from "~/shell/testing/telemetry-harness";
import { ApiHarness, ApiTelemetryHarness } from "~/shell/testing/api-harness";
import { availableLoopbackPort } from "~/shell/testing/network";
import { eventually } from "~/shell/testing/eventually";
import { EmailDeliveryPort, type EmailDeliveryPortService, EmailSendFailed } from "./delivery";
import { requestEmailReplacement } from "./replacement-transition";
import {
  ReplacementDeliveryPayload,
  ReplacementDeliveryWorkflow,
  ReplacementExpiryPayload,
  ReplacementExpiryWorkflow,
  replacementDeliveryQueue,
  replacementExpiryQueue,
} from "./replacement-protocol";
import { performReplacementAttempt } from "./replacement-delivery-worker";
import { expireReplacement, removeExpiredReplacementExecutions } from "./replacement-retention";
import {
  classifyReplacementQueueFailure,
  replacementDeliveryWorkflowLayer,
  replacementExpiryWorkflowLayer,
  replacementQueueHandlerPolicy,
} from "./replacement-workflow";
import { replacementRuntimeLayer as runtimeLayer } from "~/shell/testing/replacement-runtime";

const isSuspended = (state: Option.Option<{ readonly _tag: string }>): boolean =>
  Option.exists(state, (value) => value._tag === "Suspended");

const killAtBoundary = Effect.fn(function* (
  payload: ReplacementDeliveryPayload,
  phase: "before-call" | "after-call" | "after-settlement"
) {
  const port = yield* availableLoopbackPort;
  const codes = yield* Ref.make<ReadonlyArray<string>>([]);
  const services = yield* Effect.context<never>();
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              const proof = yield* Effect.tryPromise(() => request.text());
              yield* Ref.update(codes, (old) => [...old, proof]);
              return new Response("accepted");
            })
          ),
      })
    ),
    (value) => Effect.tryPromise(() => value.stop(true)).pipe(Effect.orDie)
  );
  const files = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* files.makeTempDirectoryScoped({ prefix: "replacement-crash-" });
  const readyPath = path.join(directory, "ready");
  const encodedPayload = yield* Schema.encodeEffect(
    Schema.fromJsonString(ReplacementDeliveryPayload)
  )(payload);
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(["bun", "src/shell/testing/replacement-crash-runner.ts"], {
        env: {
          ...process.env,
          TEST_REPLACEMENT_PAYLOAD: encodedPayload,
          TEST_REPLACEMENT_PHASE: phase,
          TEST_REPLACEMENT_PORT: String(port),
          TEST_REPLACEMENT_PROVIDER_URL: server.url.toString(),
          TEST_REPLACEMENT_READY_PATH: readyPath,
        },
        stdout: "inherit",
        stderr: "inherit",
      })
    ),
    (value) =>
      Effect.sync(() => value.kill("SIGKILL")).pipe(
        Effect.andThen(Effect.promise(() => value.exited)),
        Effect.asVoid
      )
  );
  yield* eventually(
    Effect.promise(() => Bun.file(readyPath).exists()),
    (ready) => ready,
    { interval: "20 millis", timeout: "20 seconds" }
  );
  yield* Effect.sync(() => child.kill("SIGKILL"));
  yield* Effect.promise(() => child.exited);
  return codes;
});

const TestReplacementDeliveryWorkflow = replacementDeliveryWorkflowLayer("2 seconds");
const TestReplacementExpiryWorkflow = replacementExpiryWorkflowLayer("2 seconds");

const userId = UserId.make("f1d1a000-0000-4000-8000-000000004640");
const bearer = TokenBearer.make("fin_durable1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const admit = Effect.fn(function* (email: string) {
  yield* seedConsentedPatIdentity({ userId, bearer });
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${userId}`;
  yield* sql`DELETE FROM email_delivery_admission_budgets`;
  yield* withUserTransaction(
    userId,
    requestEmailReplacement({ userId, payload: { candidateEmail: EmailAddress.make(email) } })
  );
  const [delivery] = yield* Schema.decodeUnknownEffect(Schema.Array(ReplacementDeliveryPayload))(
    yield* sql`SELECT intent.id AS "intentId", workflow.user_id AS "userId", 1 AS revision
      FROM email_replacement_delivery_intents intent
      JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
      WHERE workflow.user_id = ${userId}`
  );
  const [expiry] = yield* Schema.decodeUnknownEffect(Schema.Array(ReplacementExpiryPayload))(
    yield* sql`SELECT id AS "workflowId", user_id AS "userId", 1 AS revision
      FROM email_replacement_workflows WHERE user_id = ${userId}`
  );
  if (delivery === undefined || expiry === undefined) {
    return yield* Effect.die("expected admitted replacement");
  }
  return { delivery, expiry };
});

type ReplacementRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof runtimeLayer>>,
  Layer.Error<ReturnType<typeof runtimeLayer>>
>;

const submitDelivery = Effect.fn(function* (runtime: ReplacementRuntime) {
  const queue = replacementDeliveryQueue;
  yield* queue.handleNext(
    (payload) =>
      classifyReplacementQueueFailure(
        Effect.tryPromise(() =>
          runtime.runPromise(ReplacementDeliveryWorkflow.execute(payload, { discard: true }))
        ).pipe(Effect.orDie)
      ),
    replacementQueueHandlerPolicy
  );
});

const submitExpiry = Effect.fn(function* (runtime: ReplacementRuntime) {
  const queue = replacementExpiryQueue;
  yield* queue.handleNext(
    (payload) =>
      classifyReplacementQueueFailure(
        Effect.tryPromise(() =>
          runtime.runPromise(ReplacementExpiryWorkflow.execute(payload, { discard: true }))
        ).pipe(Effect.orDie)
      ),
    replacementQueueHandlerPolicy
  );
});

const acquireRuntime = Effect.fn(function* (provider: EmailDeliveryPortService) {
  const crypto = yield* Crypto.Crypto;
  const port = yield* availableLoopbackPort;
  const base = runtimeLayer({
    crypto,
    port,
    provider,
    deliveryLive: TestReplacementDeliveryWorkflow,
    expiryLive: TestReplacementExpiryWorkflow,
  });
  const runtime = ManagedRuntime.make(base);
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie));
  yield* Effect.tryPromise(() => runtime.runPromise(Effect.void));
  return runtime;
});

layer(ApiTelemetryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Email Replacement queue boundary",
  (it) => {
    it.effect(
      "stores only stable retry and defect markers without changing replacement state",
      () =>
        Effect.gen(function* () {
          const candidateEmail = "replacement-queue-private@example.com";
          const { delivery } = yield* admit(candidateEmail);
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-delivery' AND id <> ${delivery.intentId}`;
          const recorder = yield* EnvelopeRecorder;
          yield* recorder.clear;
          const forbidden = [
            candidateEmail,
            userId,
            `seed-${userId}@fidyapp.com`,
            "replacement-proof-private",
            "replacement-provider-diagnostic",
            "replacement-sql-detail",
            "replacement-secret",
          ];
          const logs: Array<string> = [];
          const logger = Logger.make((options) => logs.push(String(options.message)));
          const secret = Redacted.make("replacement-secret");
          const databaseFailure = SqlError.SqlError.make({
            reason: SqlError.ConnectionError.make({
              cause: Object.assign(new Error(forbidden.join(" ")), { secret }),
              message: forbidden.join(" "),
              operation: forbidden.join(" "),
            }),
          });
          const queue = replacementDeliveryQueue;

          const transientExit = yield* Effect.exit(
            queue.handleNext(
              () => classifyReplacementQueueFailure(Effect.die(databaseFailure)),
              replacementQueueHandlerPolicy
            )
          ).pipe(Effect.withLogger(logger));
          expect(Exit.isFailure(transientExit)).toBe(true);
          const [transientState] = yield* sql`SELECT completed, attempts,
            last_failure AS "lastFailure" FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-delivery' AND id = ${delivery.intentId}`;
          expect(transientState).toEqual({
            completed: false,
            attempts: 1,
            lastFailure: 'Error: {"_tag":"PersistedQueueHandlerFailure","reason":"transient"}',
          });
          expect(yield* recorder.serializedEnvelopes).toEqual([]);

          const defectExit = yield* Effect.exit(
            queue.handleNext(
              () =>
                classifyReplacementQueueFailure(
                  Effect.die(Object.assign(new Error(forbidden.join(" ")), { secret }))
                ),
              replacementQueueHandlerPolicy
            )
          ).pipe(Effect.withLogger(logger));
          expect(Exit.isFailure(defectExit)).toBe(true);
          const [defectState] = yield* sql`SELECT completed, attempts,
            last_failure AS "lastFailure" FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-delivery' AND id = ${delivery.intentId}`;
          expect(defectState).toEqual({
            completed: false,
            attempts: 2,
            lastFailure:
              'Error: {"_tag":"PersistedQueueHandlerFailure","reason":"unexpected-defect"}',
          });
          const envelopes = yield* recorder.serializedEnvelopes;
          expect(envelopes).toHaveLength(1);
          const observableText = [
            defectState?.lastFailure,
            ...logs,
            ...envelopes.map((bytes) => new TextDecoder().decode(bytes)),
          ].join("\n");
          for (const value of forbidden) {
            expect(observableText).not.toContain(value);
          }
          expect(
            yield* sql`SELECT status FROM email_replacement_delivery_intents
              WHERE id = ${delivery.intentId}`
          ).toEqual([{ status: "pending" }]);
        }),
      30_000
    );

    it.effect("releases interrupted replacement work without consuming an attempt", () =>
      Effect.gen(function* () {
        const { delivery } = yield* admit("replacement-interrupted@example.com");
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'email-replacement-delivery' AND id <> ${delivery.intentId}`;
        const queue = replacementDeliveryQueue;

        const exit = yield* Effect.exit(
          queue.handleNext(
            () => classifyReplacementQueueFailure(Effect.failCause(Cause.interrupt(42))),
            replacementQueueHandlerPolicy
          )
        );
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(
          yield* sql`SELECT completed, attempts, last_failure AS "lastFailure"
            FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-delivery' AND id = ${delivery.intentId}`
        ).toEqual([{ completed: false, attempts: 0, lastFailure: null }]);
        expect(
          yield* sql`SELECT status FROM email_replacement_delivery_intents
            WHERE id = ${delivery.intentId}`
        ).toEqual([{ status: "pending" }]);
      })
    );

    it.effect("completes expired replacement work without retaining a queue failure", () =>
      Effect.gen(function* () {
        const { expiry } = yield* admit("replacement-expired-queue@example.com");
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'email-replacement-expiry' AND id <> ${expiry.workflowId}`;
        yield* sql`UPDATE email_replacement_workflows
          SET started_at = now() - interval '24 hours 1 second',
            expires_at = now() - interval '1 second'
          WHERE id = ${expiry.workflowId}`;

        const queue = replacementExpiryQueue;
        yield* queue.handleNext(
          (payload) => classifyReplacementQueueFailure(expireReplacement(payload)),
          replacementQueueHandlerPolicy
        );

        expect(
          yield* sql`SELECT completed, attempts, last_failure AS "lastFailure"
            FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-expiry' AND id = ${expiry.workflowId}`
        ).toEqual([{ completed: true, attempts: 1, lastFailure: null }]);
        expect(
          yield* sql`SELECT 1 FROM email_replacement_workflows WHERE id = ${expiry.workflowId}`
        ).toEqual([]);
      })
    );

    it.effect("completes a compatible historical payload for a superseded replacement", () =>
      Effect.gen(function* () {
        const { delivery } = yield* admit("replacement-superseded@example.com");
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'email-replacement-delivery' AND id <> ${delivery.intentId}`;
        yield* sql`UPDATE email_replacement_delivery_intents SET status = 'superseded'
          WHERE id = ${delivery.intentId}`;
        const historicalPayload = yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              intentId: ReplacementDeliveryPayload.fields.intentId,
              userId: ReplacementDeliveryPayload.fields.userId,
            })
          )
        )({ intentId: delivery.intentId, userId: delivery.userId });
        yield* sql`UPDATE fidy_durable.fidy_queue SET element = ${historicalPayload}
          WHERE queue_name = 'email-replacement-delivery' AND id = ${delivery.intentId}`;

        const queue = replacementDeliveryQueue;
        yield* queue.handleNext(
          (payload) =>
            classifyReplacementQueueFailure(
              performReplacementAttempt(payload, 1).pipe(
                Effect.provideService(
                  EmailDeliveryPort,
                  EmailDeliveryPort.of({
                    send: () => Effect.die("superseded replacement cannot send"),
                  })
                )
              )
            ),
          replacementQueueHandlerPolicy
        );

        expect(
          yield* sql`SELECT completed, attempts, last_failure AS "lastFailure"
            FROM fidy_durable.fidy_queue
            WHERE queue_name = 'email-replacement-delivery' AND id = ${delivery.intentId}`
        ).toEqual([{ completed: true, attempts: 1, lastFailure: null }]);
        expect(
          yield* sql`SELECT 1 FROM email_replacement_delivery_attempts
            WHERE intent_id = ${delivery.intentId}`
        ).toEqual([]);
      })
    );
  }
);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "SQL Cluster replacement delivery",
  (it) => {
    it.effect("rolls back replacement state and native queue publication together", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({ userId, bearer });
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${userId}`;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        const before = yield* sql`SELECT id FROM fidy_durable.fidy_queue
      WHERE queue_name IN ('email-replacement-delivery', 'email-replacement-expiry') ORDER BY id`;
        yield* withUserTransaction(
          userId,
          requestEmailReplacement({
            userId,
            payload: { candidateEmail: EmailAddress.make("rollback-replacement@example.com") },
          }).pipe(Effect.andThen(Effect.fail("rollback")))
        ).pipe(Effect.ignore);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
        expect(
          yield* sql`SELECT id FROM fidy_durable.fidy_queue
      WHERE queue_name IN ('email-replacement-delivery', 'email-replacement-expiry') ORDER BY id`
        ).toEqual(before);
      })
    );

    it.effect(
      "bounds definitive rejection retries and never retries a permanent rejection",
      () =>
        Effect.gen(function* () {
          const calls = yield* Ref.make(0);
          const { delivery } = yield* admit("replacement-exhausted@example.com");
          const retrying = yield* acquireRuntime(
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
                ),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              retrying.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
            )
          ).toBe("rejected");
          expect(yield* Ref.get(calls)).toBe(3);
          yield* Effect.tryPromise(() => retrying.dispose());
          const permanent = yield* admit("replacement-permanent@example.com");
          yield* Ref.set(calls, 0);
          const rejecting = yield* acquireRuntime(
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: false }))
                ),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              rejecting.runPromise(ReplacementDeliveryWorkflow.execute(permanent.delivery))
            )
          ).toBe("rejected");
          expect(yield* Ref.get(calls)).toBe(1);
        }),
      30_000
    );

    it.effect(
      "coordinates duplicate delivery across independent runtimes without a second proof",
      () =>
        Effect.gen(function* () {
          const { delivery } = yield* admit("replacement-cluster-once@example.com");
          const codes = yield* Ref.make<ReadonlyArray<string>>([]);
          const provider = EmailDeliveryPort.of({
            send: ({ combinedCode }) => Ref.update(codes, (old) => [...old, combinedCode]),
          });
          const runtimeA = yield* acquireRuntime(provider);
          const runtimeB = yield* acquireRuntime(provider);
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'email-replacement-delivery' AND id <> ${delivery.intentId}`;
          yield* submitDelivery(runtimeA);
          const results = yield* Effect.tryPromise(() =>
            Promise.all([
              runtimeA.runPromise(ReplacementDeliveryWorkflow.execute(delivery)),
              runtimeB.runPromise(ReplacementDeliveryWorkflow.execute(delivery)),
            ])
          );
          expect(results).toEqual(["sent", "sent"]);
          const deliveredCodes = yield* Ref.get(codes);
          expect(deliveredCodes).toHaveLength(1);
          for (const secret of [...deliveredCodes, "replacement-cluster-once@example.com"]) {
            expect(
              yield* sql`SELECT 1 FROM fidy_durable.${sql(clusterMessagesTable)} row
        WHERE strpos(row_to_json(row)::text, ${secret}) > 0`
            ).toEqual([]);
            expect(
              yield* sql`SELECT 1 FROM fidy_durable.${sql(clusterRepliesTable)} row
        WHERE strpos(row_to_json(row)::text, ${secret}) > 0`
            ).toEqual([]);
            expect(
              yield* sql`SELECT 1 FROM fidy_durable.fidy_queue row
        WHERE strpos(row_to_json(row)::text, ${secret}) > 0`
            ).toEqual([]);
          }
          yield* Effect.tryPromise(() => Promise.all([runtimeA.dispose(), runtimeB.dispose()]));
          const runtimeC = yield* acquireRuntime(provider);
          expect(
            yield* Effect.tryPromise(() =>
              runtimeC.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
            )
          ).toBe("sent");
          expect(yield* Ref.get(codes)).toHaveLength(1);
        }),
      30_000
    );

    it.effect(
      "recovers SIGKILL before provider I/O, after acceptance, and after settlement before Activity persistence",
      () =>
        Effect.gen(function* () {
          for (const phase of ["before-call", "after-call", "after-settlement"] as const) {
            const { delivery } = yield* admit(`replacement-hard-kill-${phase}@example.com`);
            const codes = yield* killAtBoundary(delivery, phase);
            expect(yield* Ref.get(codes)).toHaveLength(phase === "before-call" ? 0 : 1);
            const runtime = yield* acquireRuntime(
              EmailDeliveryPort.of({
                send: ({ combinedCode }) => Ref.update(codes, (old) => [...old, combinedCode]),
              })
            );
            const result = yield* Effect.tryPromise(() =>
              runtime.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
            );
            expect(result).toBe(phase === "after-settlement" ? "sent" : "uncertain");
            expect(yield* Ref.get(codes)).toHaveLength(phase === "before-call" ? 0 : 1);
            yield* Effect.tryPromise(() => runtime.dispose());
          }
        }),
      90_000
    );

    it.effect(
      "reconciles graceful runtime loss after provider acceptance without another send",
      () =>
        Effect.gen(function* () {
          const { delivery } = yield* admit("replacement-cluster-ambiguous@example.com");
          const started = yield* Deferred.make<void>();
          const calls = yield* Ref.make(0);
          const runtimeA = yield* acquireRuntime(
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never)
                ),
            })
          );
          yield* Effect.tryPromise(() =>
            runtimeA.runPromise(ReplacementDeliveryWorkflow.execute(delivery, { discard: true }))
          );
          yield* Deferred.await(started);
          yield* Effect.tryPromise(() => runtimeA.dispose());
          const runtimeB = yield* acquireRuntime(
            EmailDeliveryPort.of({ send: () => Ref.update(calls, (count) => count + 1) })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtimeB.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
            )
          ).toBe("uncertain");
          expect(yield* Ref.get(calls)).toBe(1);
        }),
      30_000
    );

    it.effect(
      "resumes a definitively rejected retry after runtime replacement with a fresh proof",
      () =>
        Effect.gen(function* () {
          const { delivery } = yield* admit("replacement-cluster-retry@example.com");
          const sql = yield* MigrationSqlClient;
          yield* Effect.addFinalizer(() =>
            sql`DROP TRIGGER IF EXISTS test_delivery_second_attempt_failure ON email_replacement_delivery_attempts;
            DROP FUNCTION IF EXISTS test_delivery_second_attempt_failure()`.pipe(Effect.orDie)
          );
          yield* sql`CREATE OR REPLACE FUNCTION test_delivery_second_attempt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'delivery-database-secret-sentinel'; END $$`;
          yield* sql`CREATE TRIGGER test_delivery_second_attempt_failure BEFORE INSERT ON email_replacement_delivery_attempts
          FOR EACH ROW WHEN (NEW.attempt = 2) EXECUTE FUNCTION test_delivery_second_attempt_failure()`;
          const codes = yield* Ref.make<ReadonlyArray<string>>([]);
          const runtimeA = yield* acquireRuntime(
            EmailDeliveryPort.of({
              send: ({ combinedCode }) =>
                Ref.update(codes, (old) => [...old, combinedCode]).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
                ),
            })
          );
          yield* Effect.tryPromise(() =>
            runtimeA.runPromise(ReplacementDeliveryWorkflow.execute(delivery, { discard: true }))
          );
          const executionId = yield* ReplacementDeliveryWorkflow.executionId(delivery);
          // Attempt one settles as a retryable rejection, then attempt two parks on the durable
          // database retry — the restart boundary a replacement runtime resumes from.
          yield* eventually(
            Effect.tryPromise(() =>
              runtimeA.runPromise(ReplacementDeliveryWorkflow.poll(executionId))
            ),
            isSuspended,
            { interval: "20 millis", timeout: "5 seconds" }
          );
          expect(yield* Ref.get(codes)).toHaveLength(1);
          yield* Effect.tryPromise(() => runtimeA.dispose());
          yield* sql`DROP TRIGGER test_delivery_second_attempt_failure ON email_replacement_delivery_attempts`;
          const runtimeB = yield* acquireRuntime(
            EmailDeliveryPort.of({
              send: ({ combinedCode }) => Ref.update(codes, (old) => [...old, combinedCode]),
            })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtimeB.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
            )
          ).toBe("sent");
          const sent = yield* Ref.get(codes);
          expect(sent).toHaveLength(2);
          expect(sent[0]).not.toBe(sent[1]);
        }),
      30_000
    );

    it.effect(
      "sanitizes arming and settlement SQL failures and durably recovers the same provider attempt",
      () =>
        Effect.gen(function* () {
          const sql = yield* MigrationSqlClient;
          yield* Effect.addFinalizer(() =>
            sql`DROP TRIGGER IF EXISTS test_delivery_failure ON email_replacement_delivery_attempts;
          DROP FUNCTION IF EXISTS test_delivery_failure()`.pipe(Effect.orDie)
          );
          for (const phase of ["arming", "settlement"] as const) {
            const { delivery } = yield* admit(`replacement-database-${phase}@example.com`);
            const calls = yield* Ref.make(0);
            const runtime = yield* acquireRuntime(
              EmailDeliveryPort.of({ send: () => Ref.update(calls, (count) => count + 1) })
            );
            yield* sql`CREATE OR REPLACE FUNCTION test_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'delivery-database-secret-sentinel'; END $$`;
            if (phase === "arming") {
              yield* sql`CREATE TRIGGER test_delivery_failure BEFORE INSERT ON email_replacement_delivery_attempts FOR EACH ROW EXECUTE FUNCTION test_delivery_failure()`;
            } else {
              yield* sql`CREATE TRIGGER test_delivery_failure BEFORE UPDATE ON email_replacement_delivery_attempts FOR EACH ROW EXECUTE FUNCTION test_delivery_failure()`;
            }
            yield* Effect.tryPromise(() =>
              runtime.runPromise(ReplacementDeliveryWorkflow.execute(delivery, { discard: true }))
            );
            const executionId = yield* ReplacementDeliveryWorkflow.executionId(delivery);
            yield* eventually(
              Effect.tryPromise(() =>
                runtime.runPromise(ReplacementDeliveryWorkflow.poll(executionId))
              ),
              isSuspended,
              { interval: "20 millis", timeout: "5 seconds" }
            );
            expect(yield* Ref.get(calls)).toBe(phase === "arming" ? 0 : 1);
            expect(
              yield* sql`SELECT 1 FROM fidy_durable.${sql(clusterRepliesTable)} row
            JOIN fidy_durable.${sql(clusterMessagesTable)} message ON message.request_id = row.request_id
            WHERE message.entity_id = ${executionId} AND strpos(row_to_json(row)::text, 'delivery-database-secret-sentinel') > 0`
            ).toEqual([]);
            yield* sql`DROP TRIGGER test_delivery_failure ON email_replacement_delivery_attempts`;
            expect(
              yield* Effect.tryPromise(() =>
                runtime.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
              )
            ).toBe(phase === "arming" ? "sent" : "uncertain");
            expect(yield* Ref.get(calls)).toBe(1);
            expect(
              yield* sql`SELECT attempt FROM email_replacement_delivery_attempts WHERE intent_id = ${delivery.intentId}`
            ).toEqual([{ attempt: 1 }]);
            yield* Effect.tryPromise(() => runtime.dispose());
          }
        }),
      180_000
    );

    it.effect(
      "recovers expiry after a database failure and runtime replacement without collecting its receipt",
      () =>
        Effect.gen(function* () {
          const { expiry } = yield* admit("replacement-expiry-database@example.com");
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE email_replacement_workflows SET started_at = now() - interval '24 hours 1 second', expires_at = now() - interval '1 second' WHERE id = ${expiry.workflowId}`;
          yield* sql`UPDATE email_replacement_executions SET expires_at = now() - interval '1 second' WHERE id = ${expiry.workflowId}`;
          yield* Effect.addFinalizer(() =>
            sql`DROP TRIGGER IF EXISTS test_replacement_expiry_failure ON email_replacement_workflows;
            DROP FUNCTION IF EXISTS test_replacement_expiry_failure()`.pipe(Effect.orDie)
          );
          yield* sql`CREATE FUNCTION test_replacement_expiry_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'expiry-database-secret-sentinel'; END $$;
          CREATE TRIGGER test_replacement_expiry_failure BEFORE DELETE ON email_replacement_workflows
          FOR EACH ROW EXECUTE FUNCTION test_replacement_expiry_failure()`;
          const runtimeA = yield* acquireRuntime(EmailDeliveryPort.of({ send: () => Effect.void }));
          yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'email-replacement-expiry' AND id <> ${expiry.workflowId}`;
          yield* submitExpiry(runtimeA);
          const executionId = yield* ReplacementExpiryWorkflow.executionId(expiry);
          yield* eventually(
            Effect.tryPromise(() =>
              runtimeA.runPromise(ReplacementExpiryWorkflow.poll(executionId))
            ),
            isSuspended,
            { interval: "20 millis", timeout: "5 seconds" }
          );
          yield* Effect.tryPromise(() => runtimeA.runPromise(removeExpiredReplacementExecutions()));
          expect(
            yield* sql`SELECT id FROM email_replacement_executions WHERE id = ${expiry.workflowId}`
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT 1 FROM fidy_durable.${sql(clusterRepliesTable)} row
                JOIN fidy_durable.${sql(clusterMessagesTable)} message ON message.request_id = row.request_id
                WHERE message.entity_id = ${executionId} AND strpos(row_to_json(row)::text, 'expiry-database-secret-sentinel') > 0`
          ).toEqual([]);
          yield* Effect.tryPromise(() => runtimeA.dispose());
          yield* sql`DROP TRIGGER test_replacement_expiry_failure ON email_replacement_workflows`;
          const runtimeB = yield* acquireRuntime(EmailDeliveryPort.of({ send: () => Effect.void }));
          yield* Effect.tryPromise(() =>
            runtimeB.runPromise(ReplacementExpiryWorkflow.execute(expiry))
          );
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
          yield* Effect.tryPromise(() => runtimeB.runPromise(removeExpiredReplacementExecutions()));
          expect(
            yield* sql`SELECT id FROM email_replacement_executions WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
        }),
      90_000
    );

    it.effect(
      "retains execution receipts until both their deadline and completed publication allow cleanup",
      () =>
        Effect.gen(function* () {
          const { delivery } = yield* admit("replacement-history@example.com");
          const sql = yield* MigrationSqlClient;
          // Isolate this publication for the finite native consumer; other tests intentionally execute directly.
          yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'email-replacement-delivery' AND id <> ${delivery.intentId}`;
          const runtime = yield* acquireRuntime(EmailDeliveryPort.of({ send: () => Effect.void }));
          const executionId = yield* ReplacementDeliveryWorkflow.executionId(delivery);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(ReplacementDeliveryWorkflow.execute(delivery))
          );
          yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${userId}`;
          yield* Effect.tryPromise(() => runtime.runPromise(removeExpiredReplacementExecutions()));
          expect(
            yield* sql`SELECT id FROM email_replacement_executions WHERE id = ${delivery.intentId}`
          ).toHaveLength(1);
          yield* sql`UPDATE email_replacement_executions SET expires_at = now() - interval '1 second' WHERE id = ${delivery.intentId}`;
          // A full oldest page of missing/nonterminal executions must not starve later terminal GC.
          yield* sql`INSERT INTO email_replacement_executions (id, user_id, kind, expires_at)
            SELECT ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
              ${userId}::uuid, 'delivery', now() - interval '1 day'
            FROM generate_series(1, 100) value`;
          const batch = yield* Effect.tryPromise(() =>
            runtime.runPromise(removeExpiredReplacementExecutions())
          );
          expect(batch.overdue).toBe(100);
          expect(Option.isSome(batch.nextCursor)).toBe(true);
          expect(
            yield* sql`SELECT id FROM email_replacement_executions WHERE id = ${delivery.intentId}`
          ).toHaveLength(1);
          const queue = replacementDeliveryQueue;
          yield* queue.handleNext(() => Effect.void, replacementQueueHandlerPolicy);
          yield* Effect.tryPromise(() =>
            runtime.runPromise(removeExpiredReplacementExecutions(batch.nextCursor))
          );
          expect(
            yield* sql`SELECT id FROM email_replacement_executions WHERE id = ${delivery.intentId}`
          ).toEqual([]);
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(ReplacementDeliveryWorkflow.poll(executionId))
            )
          ).toEqual(Option.none());
        }),
      30_000
    );

    it.effect(
      "expires the original replacement after the waiting runtime is replaced",
      () =>
        Effect.gen(function* () {
          const { expiry } = yield* admit("replacement-cluster-expiry@example.com");
          const sql = yield* MigrationSqlClient;
          const provider = EmailDeliveryPort.of({
            send: () => Effect.die("expiry cannot send email"),
          });
          const runtimeA = yield* acquireRuntime(provider);
          // Start the waiting window only once the runtime is ready, so a slow shard hand-off cannot
          // expire the replacement before the workflow observes the waiting boundary at all.
          const deadline = DateTime.add(yield* DateTime.now, { seconds: 2 });
          yield* sql`UPDATE email_replacement_workflows SET expires_at = ${deadline},
      started_at = ${DateTime.subtract(deadline, { hours: 24 })} WHERE id = ${expiry.workflowId}`;
          yield* Effect.tryPromise(() =>
            runtimeA.runPromise(ReplacementExpiryWorkflow.execute(expiry, { discard: true }))
          );
          const id = yield* ReplacementExpiryWorkflow.executionId(expiry);
          yield* eventually(
            Effect.tryPromise(() => runtimeA.runPromise(ReplacementExpiryWorkflow.poll(id))),
            isSuspended,
            { interval: "20 millis", timeout: "5 seconds" }
          );
          yield* Effect.tryPromise(() => runtimeA.dispose());
          const runtimeB = yield* acquireRuntime(provider);
          yield* Effect.tryPromise(() =>
            runtimeB.runPromise(ReplacementExpiryWorkflow.execute(expiry))
          );
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE id = ${expiry.workflowId}`
          ).toEqual([]);
        }),
      30_000
    );
  }
);
