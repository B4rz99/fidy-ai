import { expect, layer } from "@effect/vitest";
import {
  BigDecimal,
  type Config,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schema,
} from "effect";
import {
  ClusterWorkflowEngine,
  type MessageStorage,
  RunnerAddress,
  type Runners,
  type Sharding,
} from "effect/unstable/cluster";
import type { HttpServerError } from "effect/unstable/http";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";
import { Money } from "~/core/_shared/money";
import { makeColombianUser } from "~/core/identity/rules";
import { UserId } from "~/core/identity/reference";
import {
  type ReceivedEmailContent,
  ReceivedEmailContent as ReceivedEmailContentSchema,
} from "~/core/ingestion/model";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { TestPublicNamespace } from "~/shell/testing/test-config";
import { runEmailIngestRetention } from "./email-retention";
import { publishForwardedEmailWorkflow } from "./forwarded-email-execution";
import {
  NotificationEmailExtractor,
  type NotificationEmailExtractorService,
} from "./email-extractor";
import {
  ForwardedEmailWorkflow,
  ForwardedEmailWorkflowLive,
  retainForwardedEmailExecutions,
} from "./forwarded-email-workflow";
import {
  ResendReceivingClient,
  type ResendReceivingClientService,
} from "./resend-receiving-client";

const clusterToken = "f".repeat(64);
const isolatedUserId = UserId.make("f1d1a000-0000-4000-8000-000000000462");

const cleanupIsolatedUser = Effect.fn("test.cleanupForwardedEmailIsolatedUser")(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${isolatedUserId}`;
      yield* sql`DELETE FROM users WHERE id = ${isolatedUserId}`;
    })
  );
});

const cleanup = Effect.fn("test.cleanupForwardedEmailWorkflow")(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    TRUNCATE forwarded_email_interpretations, anonymized_email_ingest_samples,
      email_needs_review_items, raw_email_ingest_samples, source_attestations,
      forwarded_email_receipts, email_forwarding_addresses,
      forwarded_email_user_admission_windows, forwarded_email_known_admission_window,
      resend_webhook_deliveries, resend_webhook_admission_window
  `;
  yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'forwarded-email-ingestion'`;
});

const admit = Effect.fn("test.admitForwardedEmailWorkflow")(function* (receivedEmailId: string) {
  yield* cleanup();
  const client = yield* ApiHarnessClient;
  const sql = yield* MigrationSqlClient;
  const enabled = yield* client.ingestion.enableEmailForwarding();
  const admittedAt = yield* DateTime.now;
  yield* sql`
    INSERT INTO forwarded_email_receipts (
      received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
      time_zone, period_start, consumes_free_allowance, admitted_at
    ) VALUES (
      ${receivedEmailId}, ${defaultUserId}, ${`workflow-${receivedEmailId}`}, 'accepted',
      'CO', 'es-CO', 'America/Bogota', ${admittedAt}, true, ${admittedAt}
    )
  `;
  const durableReceivedEmailId = ResendReceivedEmailId.make(receivedEmailId);
  yield* publishForwardedEmailWorkflow(defaultUserId, durableReceivedEmailId);
  return {
    payload: {
      userId: defaultUserId,
      receivedEmailId: durableReceivedEmailId,
      revision: 1 as const,
    },
    address: enabled.data.address,
  };
});

const providerContent = (
  receivedEmailId: ResendReceivedEmailId,
  address: string
): ReceivedEmailContent =>
  ReceivedEmailContentSchema.make({
    receivedEmailId,
    from: "alerts@example.test",
    to: [address],
    subject: "Compra aprobada",
    text: Option.some("Compra por COP 25000"),
    html: Option.none(),
    inlineImages: [],
    messageId: Option.some(`provider-${receivedEmailId}`),
    createdAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
  });

const successfulExtractor: NotificationEmailExtractorService = NotificationEmailExtractor.of({
  extract: () =>
    Effect.succeed({
      money: Money.make({ amount: BigDecimal.fromStringUnsafe("25000"), currency: "COP" }),
      counterparty: Option.some("Comercio de prueba"),
      direction: "outflow",
      occurredAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
    }),
});

type RuntimeLayerInput = Readonly<{
  crypto: Crypto.Crypto;
  port: number;
  provider: ResendReceivingClientService;
  extractor: NotificationEmailExtractorService;
}>;

const makeRuntimeLayer = (
  input: RuntimeLayerInput
): Layer.Layer<
  | Crypto.Crypto
  | MessageStorage.MessageStorage
  | Runners.Runners
  | SqlClient.SqlClient
  | Sharding.Sharding
  | WorkflowEngine.WorkflowEngine,
  Config.ConfigError | HttpServerError.ServeError | SqlError.SqlError
> => {
  const cluster = authenticatedClusterHttp.layerSql(clusterToken, {
    runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", input.port)),
    runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", input.port)),
    availableShardGroups: ["default"],
    assignedShardGroups: ["default"],
    shardsPerGroup: 300,
    entityMessagePollInterval: 100,
    sendRetryInterval: 100,
  });
  return ForwardedEmailWorkflowLive.pipe(
    Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster))),
    Layer.provide(Layer.succeed(ResendReceivingClient, input.provider)),
    Layer.provide(Layer.succeed(NotificationEmailExtractor, input.extractor)),
    Layer.provideMerge(Layer.succeed(Crypto.Crypto, input.crypto)),
    Layer.provideMerge(PgLive),
    Layer.provide(TestPublicNamespace)
  );
};

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "SQL Cluster forwarded-email workflow",
  (it) => {
    it.effect(
      "coordinates one idempotent workflow across independent runtimes",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const suffix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const admitted = yield* admit(suffix);
          const calls = yield* Ref.make(0);
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const runtimeA = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44611, provider, extractor: successfulExtractor })
          );
          const runtimeB = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44612, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtimeA.runPromise(Effect.void));
          yield* Effect.promise(() => runtimeB.runPromise(Effect.void));
          yield* Effect.tryPromise(() =>
            Promise.all([
              runtimeA.runPromise(ForwardedEmailWorkflow.execute(admitted.payload)),
              runtimeB.runPromise(ForwardedEmailWorkflow.execute(admitted.payload)),
            ])
          );
          expect(yield* Ref.get(calls)).toBe(1);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ status: "completed" }]);
          const durableRows = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ payload: Schema.String }))
          )(
            yield* sql`
            SELECT element AS payload FROM fidy_durable.fidy_queue
            WHERE queue_name = 'forwarded-email-ingestion'
              AND element::jsonb->>'receivedEmailId' = ${admitted.payload.receivedEmailId}
            UNION ALL
            SELECT payload FROM fidy_durable.cluster_messages
            WHERE entity_type = 'Workflow/ForwardedEmailIngestion'
            UNION ALL
            SELECT payload FROM fidy_durable.cluster_replies
          `
          ).pipe(Effect.orDie);
          const durableText = durableRows.map(({ payload }) => payload).join("\n");
          expect(durableText).not.toContain("Compra aprobada");
          expect(durableText).not.toContain("Compra por COP 25000");
          expect(durableText).not.toContain(admitted.address);
          yield* sql`UPDATE fidy_durable.fidy_queue SET completed = true
            WHERE queue_name = 'forwarded-email-ingestion'
              AND element::jsonb->>'receivedEmailId' = ${admitted.payload.receivedEmailId}`;
          yield* cleanupIsolatedUser();
          yield* upsertStableUserFixture(
            isolatedUserId,
            yield* makeColombianUser(isolatedUserId, {
              paidTier: "free",
              createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
            })
          );
          yield* sql`
            INSERT INTO forwarded_email_receipts (
              received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
              time_zone, period_start, consumes_free_allowance, completed_at, admitted_at
            )
            SELECT 'blocked-retention-' || series,
              CASE WHEN series <= 50 THEN ${defaultUserId}::uuid ELSE ${isolatedUserId}::uuid END,
              'blocked-retention-delivery-' || series, 'expired', 'CO', 'es-CO',
              'America/Bogota', now(), true, now() - interval '91 days', now() - interval '91 days'
            FROM generate_series(1, 100) AS series
          `;
          yield* sql`
            INSERT INTO fidy_durable.fidy_queue (
              id, queue_name, element, completed, attempts, created_at, updated_at
            )
            SELECT receipt.received_email_id, 'forwarded-email-ingestion',
              json_build_object(
                'userId', receipt.user_id,
                'receivedEmailId', receipt.received_email_id,
                'revision', 1
              )::text,
              true, 0, now() - interval '1 day', now() - interval '1 day'
            FROM forwarded_email_receipts AS receipt
            WHERE receipt.received_email_id LIKE 'blocked-retention-%'
          `;
          const retentionNow = DateTime.add(yield* DateTime.now, { days: 91 });
          expect(
            yield* Effect.promise(() =>
              runtimeA.runPromise(
                retainForwardedEmailExecutions({ now: retentionNow, retentionDays: 90 })
              )
            )
          ).toBe(0);
          expect(
            yield* Effect.promise(() =>
              runtimeA.runPromise(
                retainForwardedEmailExecutions({ now: retentionNow, retentionDays: 90 })
              )
            )
          ).toBe(1);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.fidy_queue
              WHERE queue_name = 'forwarded-email-ingestion'
                AND element::jsonb->>'receivedEmailId' = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ count: 0 }]);
          yield* Effect.promise(() => Promise.all([runtimeA.dispose(), runtimeB.dispose()]));
          yield* cleanup();
          yield* cleanupIsolatedUser();
        }),
      30_000
    );

    it.effect(
      "resumes cleanup after completion proof survives missing workflow history",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const admitted = yield* admit(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE forwarded_email_receipts
            SET status = 'expired', completed_at = now() - interval '91 days',
              durable_cleanup_checked_at = now(), durable_cleanup_started_at = now()
            WHERE received_email_id = ${admitted.payload.receivedEmailId}`;
          yield* sql`UPDATE fidy_durable.fidy_queue SET completed = true
            WHERE queue_name = 'forwarded-email-ingestion'
              AND element::jsonb->>'receivedEmailId' = ${admitted.payload.receivedEmailId}`;
          const provider = ResendReceivingClient.of({
            retrieveEmail: () => Effect.die(new Error("Retention performed provider Work")),
          });
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44620, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          const retentionNow = DateTime.add(yield* DateTime.now, { days: 91 });
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(
                retainForwardedEmailExecutions({ now: retentionNow, retentionDays: 90 })
              )
            )
          ).toBe(1);
          expect(
            yield* sql`SELECT durable_cleanup_cleared_at IS NOT NULL AS cleared
              FROM forwarded_email_receipts
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ cleared: true }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.fidy_queue
              WHERE queue_name = 'forwarded-email-ingestion'
                AND element::jsonb->>'receivedEmailId' = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ count: 0 }]);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "replays a committed settlement whose Activity result is absent",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const admitted = yield* admit(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE forwarded_email_receipts
            SET status = 'completed', completed_at = now(), transaction_id = gen_random_uuid()
            WHERE received_email_id = ${admitted.payload.receivedEmailId}`;
          const calls = yield* Ref.make(0);
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44617, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
            )
          ).toEqual({ outcome: "completed" });
          expect(yield* Ref.get(calls)).toBe(0);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "returns persisted expiry without provider or domain work",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const admitted = yield* admit(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE forwarded_email_receipts
            SET status = 'expired', completed_at = now()
            WHERE received_email_id = ${admitted.payload.receivedEmailId}`;
          const calls = yield* Ref.make(0);
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44619, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
            )
          ).toEqual({ outcome: "expired" });
          expect(yield* Ref.get(calls)).toBe(0);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "rejects a second User in the durable payload before provider or domain access",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const suffix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const admitted = yield* admit(suffix);
          yield* cleanupIsolatedUser();
          yield* upsertStableUserFixture(
            isolatedUserId,
            yield* makeColombianUser(isolatedUserId, {
              paidTier: "pro",
              createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
            })
          );
          const calls = yield* Ref.make(0);
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44615, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          const result = yield* Effect.promise(() =>
            runtime.runPromise(
              ForwardedEmailWorkflow.execute({ ...admitted.payload, userId: isolatedUserId })
            )
          );
          expect(result).toEqual({ outcome: "stale" });
          expect(yield* Ref.get(calls)).toBe(0);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ status: "accepted" }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM raw_email_ingest_samples
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ count: 0 }]);
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
            )
          ).toEqual({ outcome: "completed" });
          expect(yield* Ref.get(calls)).toBe(1);
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
          yield* cleanupIsolatedUser();
        }),
      30_000
    );

    it.effect(
      "hands off deferred execution, serves ready work, and resumes its durable sleep",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const readyId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const deferredId = ResendReceivedEmailId.make(
            yield* crypto.randomUUIDv4.pipe(Effect.orDie)
          );
          const admitted = yield* admit(readyId);
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
          const now = yield* DateTime.now;
          yield* sql`
            INSERT INTO forwarded_email_receipts (
              received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
              time_zone, period_start, consumes_free_allowance, resume_at, admitted_at
            ) VALUES (
              ${deferredId}, ${defaultUserId}, ${`workflow-${deferredId}`}, 'deferred',
              'CO', 'es-CO', 'America/Bogota', ${now}, true,
              ${DateTime.add(now, { seconds: 5 })}, ${now}
            )
          `;
          const calls = yield* Ref.make(0);
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const runtime = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44616, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          yield* Effect.promise(() =>
            runtime.runPromise(
              ForwardedEmailWorkflow.execute(
                { userId: defaultUserId, receivedEmailId: deferredId, revision: 1 },
                { discard: true }
              )
            )
          );
          yield* Effect.promise(() =>
            runtime.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
          );
          expect(yield* Ref.get(calls)).toBe(1);
          yield* Effect.sleep("6 seconds");
          yield* Effect.promise(() =>
            runtime.runPromise(
              ForwardedEmailWorkflow.execute({
                userId: defaultUserId,
                receivedEmailId: deferredId,
                revision: 1,
              })
            )
          );
          expect(yield* Ref.get(calls)).toBe(2);
          expect(
            yield* sql`SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = ${deferredId}`
          ).toEqual([{ status: "completed" }]);
          yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
          yield* Effect.promise(() => runtime.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "resumes after runner replacement without repeating retained provider retrieval",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const suffix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const admitted = yield* admit(suffix);
          const calls = yield* Ref.make(0);
          const interpretationStarted = yield* Deferred.make<void>();
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const blockedExtractor = NotificationEmailExtractor.of({
            extract: () =>
              Deferred.succeed(interpretationStarted, undefined).pipe(Effect.andThen(Effect.never)),
          });
          const runtimeA = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44613, provider, extractor: blockedExtractor })
          );
          const runtimeB = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44614, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtimeA.runPromise(Effect.void));
          const first = yield* Effect.promise(() =>
            runtimeA.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
          ).pipe(Effect.ignore, Effect.forkChild);
          yield* Deferred.await(interpretationStarted);
          yield* Effect.promise(() => runtimeB.runPromise(Effect.void));
          yield* Effect.promise(() => runtimeA.dispose());
          yield* Fiber.interrupt(first);
          yield* Effect.promise(() =>
            runtimeB.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
          );
          expect(yield* Ref.get(calls)).toBe(1);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ status: "completed" }]);
          yield* Effect.promise(() => runtimeB.dispose());
          yield* cleanup();
        }),
      30_000
    );

    it.effect(
      "re-enters retrieval when evidence retention outlives persisted activity progress",
      () =>
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const suffix = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const admitted = yield* admit(suffix);
          const calls = yield* Ref.make(0);
          const interpretationStarted = yield* Deferred.make<void>();
          const provider = ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(providerContent(receivedEmailId, admitted.address))
              ),
          });
          const blockedExtractor = NotificationEmailExtractor.of({
            extract: () =>
              Deferred.succeed(interpretationStarted, undefined).pipe(Effect.andThen(Effect.never)),
          });
          const runtimeA = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44621, provider, extractor: blockedExtractor })
          );
          const runtimeB = ManagedRuntime.make(
            makeRuntimeLayer({ crypto, port: 44622, provider, extractor: successfulExtractor })
          );
          yield* Effect.promise(() => runtimeA.runPromise(Effect.void));
          const first = yield* Effect.promise(() =>
            runtimeA.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
          ).pipe(Effect.ignore, Effect.forkChild);
          yield* Deferred.await(interpretationStarted);
          yield* Effect.promise(() => runtimeB.runPromise(Effect.void));
          yield* Effect.promise(() => runtimeA.dispose());
          yield* Fiber.interrupt(first);
          yield* runEmailIngestRetention(DateTime.add(yield* DateTime.now, { days: 91 }));
          yield* Effect.promise(() =>
            runtimeB.runPromise(ForwardedEmailWorkflow.execute(admitted.payload))
          );
          expect(yield* Ref.get(calls)).toBe(2);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = ${admitted.payload.receivedEmailId}`
          ).toEqual([{ status: "completed" }]);
          yield* Effect.promise(() => runtimeB.dispose());
          yield* cleanup();
        }),
      30_000
    );
  }
);
