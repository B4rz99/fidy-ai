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
  Stream,
} from "effect";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { EmailAddress } from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { emailCredentialLookupKey } from "./admission";
import { BrowserPairingEmailWorkflowLive } from "./authentication-delivery-worker";
import { processBrowserPairingEmailStartRequest } from "./browser-pairing-authentication";
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

const admit = Effect.fn(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name IN ('browser-pairing-email-start', 'browser-pairing-email-delivery', 'browser-pairing-email-expiry')`;
  yield* sql`DELETE FROM browser_pairing_email_start_requests`;
  yield* sql`DELETE FROM browser_pairing_email_workflows`;
  yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
  yield* sql`DELETE FROM email_delivery_admission_budgets`;
  yield* sql`DELETE FROM browser_login_start_attempts`;
  yield* seedConsentedPatIdentity({ userId, bearer });
  const lookup = yield* emailCredentialLookupKey(email);
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
  const queue = yield* pairingStartQueue;
  yield* queue.take(({ requestId }) => processBrowserPairingEmailStartRequest(requestId));
  const payloads = yield* Schema.decodeUnknownEffect(Schema.Array(PairingDeliveryPayload))(
    yield* sql`SELECT 1 AS revision, intent.id AS "intentId", workflow.user_id AS "userId"
      FROM browser_pairing_email_delivery_intents intent JOIN browser_pairing_email_workflows workflow ON workflow.id = intent.workflow_id
      WHERE workflow.pairing_id = ${pairing.pairingId}`
  );
  const payload = payloads[0];
  if (payload === undefined) return yield* Effect.die("expected accepted delivery");
  return { payload, pairing };
});

const runtimeFor = Effect.fn(function* (port: number, provider: EmailDeliveryPortService) {
  const crypto = yield* Crypto.Crypto;
  const cluster = authenticatedClusterHttp.layerSql("c".repeat(64), {
    runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
    runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
    availableShardGroups: ["default"],
    assignedShardGroups: ["default"],
    shardsPerGroup: 300,
    entityMessagePollInterval: 50,
    sendRetryInterval: 50,
    runnerHealthCheckInterval: 100,
    refreshAssignmentsInterval: 100,
    shardLockRefreshInterval: 250,
    shardLockExpiration: "2 seconds",
  });
  return yield* Effect.acquireRelease(
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
            24644,
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
          const provider = EmailDeliveryPort.of({
            send: () =>
              Ref.update(sends, (count) => count + 1).pipe(Effect.andThen(Effect.sleep(100))),
          });
          const firstRuntime = yield* runtimeFor(24631, provider);
          const replacementRuntime = yield* runtimeFor(24632, provider);
          const results = yield* Effect.tryPromise(() =>
            Promise.all([
              firstRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload)),
              replacementRuntime.runPromise(BrowserPairingEmailDeliveryWorkflow.execute(payload)),
            ])
          );
          expect(results).toEqual([{ outcome: "sent" }, { outcome: "sent" }]);
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
            24633,
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
              BrowserPairingEmailDeliveryWorkflow.execute(payload, { discard: true })
            )
          );
          yield* Deferred.await(accepted);
          yield* Effect.tryPromise(() => firstRuntime.dispose());
          const replacementRuntime = yield* runtimeFor(
            24634,
            EmailDeliveryPort.of({ send: () => Ref.update(sends, (count) => count + 1) })
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
            24635,
            EmailDeliveryPort.of({
              send: (input) =>
                Ref.update(inputs, (values) => [...values, input]).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
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
            yield* sql`SELECT * FROM fidy_durable.cluster_messages`
          );
          const replies = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            yield* sql`SELECT * FROM fidy_durable.cluster_replies`
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
            24647,
            EmailDeliveryPort.of({
              send: () =>
                Ref.update(sends, (count) => count + 1).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: false }))
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
            24639,
            EmailDeliveryPort.of({
              send: (input) =>
                Ref.update(inputs, (values) => [...values, input]).pipe(
                  Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
                ),
            })
          );
          yield* Effect.tryPromise(() =>
            firstRuntime.runPromise(
              BrowserPairingEmailDeliveryWorkflow.execute(payload, { discard: true })
            )
          );
          const sql = yield* MigrationSqlClient;
          yield* Effect.gen(function* () {
            for (;;) {
              const rows =
                yield* sql`SELECT id FROM browser_pairing_email_delivery_intents WHERE id = ${payload.intentId} AND status = 'temporarily-refused'`;
              if (rows.length > 0) return;
              yield* Effect.sleep(5);
            }
          }).pipe(Effect.timeout("5 seconds"));
          yield* Effect.tryPromise(() => firstRuntime.dispose());
          const replacementRuntime = yield* runtimeFor(
            24640,
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
            24641,
            EmailDeliveryPort.of({ send: () => Effect.die("settled delivery must not replay") })
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
          const runtime = yield* runtimeFor(
            24642,
            EmailDeliveryPort.of({ send: () => Effect.void })
          );
          const queue = yield* pairingDeliveryQueue;
          yield* queue.take((input) =>
            Effect.tryPromise(
              runtime.runPromise.bind(
                runtime,
                BrowserPairingEmailDeliveryWorkflow.execute(input),
                undefined
              )
            )
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
            24646,
            EmailDeliveryPort.of({ send: () => Effect.die("expiry must not send") })
          );
          const queue = yield* pairingExpiryQueue;
          const expiry = yield* queue.take((input) =>
            Effect.tryPromise(
              runtime.runPromise.bind(
                runtime,
                BrowserPairingEmailExpiryWorkflow.execute(input, { discard: true }),
                undefined
              )
            ).pipe(Effect.as(input))
          );
          const executionId = yield* BrowserPairingEmailExpiryWorkflow.executionId(expiry);
          const suspended = BrowserPairingEmailExpiryWorkflow.poll(executionId).pipe(
            Effect.delay("25 millis"),
            Effect.repeat({ until: Option.exists((state) => state._tag === "Suspended") }),
            Effect.timeout("5 seconds")
          );
          yield* Effect.tryPromise(() => runtime.runPromise(suspended));
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
            yield* sql`SELECT id FROM fidy_durable.cluster_messages WHERE entity_id = ${executionId}`
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
            24636,
            EmailDeliveryPort.of({ send: () => Ref.update(sends, (count) => count + 1) })
          );
          expect(
            yield* Effect.tryPromise(() =>
              runtime.runPromise(
                BrowserPairingEmailDeliveryWorkflow.execute({ ...payload, userId: otherUserId })
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
          const runtime = yield* runtimeFor(
            24645,
            EmailDeliveryPort.of({ send: () => Effect.void })
          );
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
              BrowserPairingEmailExpiryWorkflow.execute({ ...expiry, userId: otherUserId })
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
          const provider = EmailDeliveryPort.of({ send: () => Effect.die("expiry must not send") });
          yield* killAtBoundary("expiry", expiry.userId, expiry.workflowId);
          const replacementRuntime = yield* runtimeFor(24638, provider);
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
