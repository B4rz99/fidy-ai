import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema, type Scope } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { type SqlClient, type SqlError } from "effect/unstable/sql";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { decodeEnvelopeItems } from "~/shell/testing/telemetry-fixtures";
import {
  durableQueueAttentionLogAnnotations,
  durableQueueHealthSchedule,
  getDurableQueueHealthFor,
  observeDurableQueueHealthFor,
  projectDurableQueueReadiness,
} from "./durable-queue-health";
import {
  classifyDurableQueueAttention,
  durableQueueSchemaIncompatibleMarker,
  durableQueueTableName,
} from "./durable-queue-policy";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "./observability/envelope-recorder";
import { ProjectedTransaction } from "./observability/projectors";
import { runScheduledWork } from "./observability/scheduled-work";
import { Telemetry } from "./observability/telemetry";

const testQueueName = "test-durable-queue-health";
const lostWorkerId = "f1d1a000-0000-4000-8000-00000000dead";

const TestPayload = Schema.Struct({ note: Schema.String });
const makeTestQueue = PersistedQueue.make({ name: testQueueName, schema: TestPayload });

/**
 * Independent store runtime: every fresh build opens its own worker identity, pool, and poll
 * loop, so two builds behave as two runtimes sharing only Postgres.
 */
const testRuntime = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({
      tableName: durableQueueTableName,
      pollInterval: "10 millis",
      lockRefreshInterval: "50 millis",
      lockExpiration: "2 seconds",
    })
  ),
  Layer.provideMerge(Layer.fresh(PgLive))
);

const HealthHarness = Layer.mergeAll(MigrationSqlClient.layer, MigratorLive, PgLive).pipe(
  Layer.provideMerge(BunServices.layer)
);

type TestRowInput = Readonly<{
  readonly id: string;
  readonly element: string;
  readonly attempts: number;
  readonly lastFailure: Option.Option<string>;
  readonly acquiredBy: Option.Option<string>;
  readonly acquiredMinutesAgo: Option.Option<number>;
  readonly createdMinutesAgo: number;
}>;

const clearTestQueue = Effect.gen(function* () {
  const admin = yield* MigrationSqlClient;
  yield* admin`DELETE FROM ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
    WHERE queue_name = ${testQueueName}`;
});

const insertTestRow = (
  input: TestRowInput
): Effect.Effect<void, SqlError.SqlError, MigrationSqlClient> =>
  Effect.gen(function* () {
    const admin = yield* MigrationSqlClient;
    yield* admin`INSERT INTO ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
      (id, queue_name, element, completed, attempts, last_failure, acquired_at, acquired_by,
        created_at, updated_at)
      VALUES (
        ${input.id}, ${testQueueName}, ${input.element}, FALSE, ${input.attempts},
        ${Option.getOrNull(input.lastFailure)},
        now() - ((${Option.getOrNull(input.acquiredMinutesAgo)} || ' minutes')::interval),
        ${Option.getOrNull(input.acquiredBy)},
        now() - ((${input.createdMinutesAgo} || ' minutes')::interval),
        now()
      )`;
  });

const pendingRow = (
  id: string,
  overrides?: Partial<TestRowInput>
): Effect.Effect<void, SqlError.SqlError, MigrationSqlClient> =>
  insertTestRow({
    id,
    element: `{"note":"${id}"}`,
    attempts: 0,
    lastFailure: Option.none(),
    acquiredBy: Option.none(),
    acquiredMinutesAgo: Option.none(),
    createdMinutesAgo: 0,
    ...overrides,
  });

/** Builds one queue handle from a freshly provisioned independent store runtime. */
const buildTestQueue = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.fresh(testRuntime));
  return yield* makeTestQueue.pipe(Effect.provide(context));
});

/** Scans already-enumerated health values for leaked payload, identity, or failure text. */
const expectNoSentinels = (values: ReadonlyArray<unknown>): void => {
  for (const value of values) {
    expect(String(value)).not.toContain("sentinel");
  }
};

const healthKeys = [
  "queueName",
  "pendingDepth",
  "oldestPendingAgeSeconds",
  "retainedCount",
  "oldestRetainedAgeSeconds",
  "activeLeaseCount",
  "staleLeaseCount",
  "stalledLeaseCount",
  "redeliveredCount",
  "failedCount",
  "decodeFailureCount",
  "exhaustedCount",
].sort();

const attentionAnnotationKeys = [
  "queue_name",
  "pending_depth",
  "oldest_pending_age_seconds",
  "retained_count",
  "oldest_retained_age_seconds",
  "active_lease_count",
  "stale_lease_count",
  "stalled_lease_count",
  "redelivered_count",
  "failed_count",
  "decode_failure_count",
  "exhausted_count",
  "backlog",
  "lease_churn",
  "exhausted",
  "decode_failure",
].sort();

/**
 * Runs the probe through the production scheduled-work wrapper and its recording Sentry adapter,
 * then reconstructs the exact serialized transaction the exporter would send.
 */
const runObservedProbe = (
  queueNames: ReadonlyArray<string>
): Effect.Effect<
  Readonly<{
    transactions: ReadonlyArray<ProjectedTransaction>;
    serialized: string;
  }>,
  never,
  Scope.Scope | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    yield* runScheduledWork(durableQueueHealthSchedule)(
      observeDurableQueueHealthFor(queueNames)
    ).pipe(Effect.provideService(Telemetry, telemetry));
    const envelopes = yield* recorder.serializedEnvelopes;
    const items = envelopes.flatMap(decodeEnvelopeItems);
    return {
      transactions: items
        .flatMap((item) => Option.toArray(Schema.decodeUnknownOption(ProjectedTransaction)(item)))
        .filter((transaction) => transaction.transaction === "task.durableQueueHealth"),
      serialized: envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n"),
    };
  });

layer(HealthHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "durable queue two-runtime behavior",
  (it) => {
    it.effect("keeps a live lease invisible to a second runtime until its handler settles", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        const queueA = yield* buildTestQueue;
        const queueB = yield* buildTestQueue;
        yield* queueA.offer({ note: "held" }, { id: "health-test-held" });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fiberA = yield* queueA
          .take((payload) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(payload)
            )
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const stolen = yield* queueB
          .take(() => Effect.succeed("stolen"))
          .pipe(Effect.timeoutOption("500 millis"));
        expect(Option.isNone(stolen)).toBe(true);
        const admin = yield* MigrationSqlClient;
        const rows = yield* admin`SELECT attempts, acquired_by IS NOT NULL AS "held"
          FROM ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
          WHERE queue_name = ${testQueueName} AND id = 'health-test-held'`;
        expect(rows).toEqual([{ attempts: 0, held: true }]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fiberA)).toEqual({ note: "held" });
      })
    );

    it.effect("redelivers work a lost runtime never released after its lease expires", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-test-lost", {
          element: '{"note":"lost"}',
          acquiredBy: Option.some(lostWorkerId),
          acquiredMinutesAgo: Option.some(10),
        });
        const replacement = yield* buildTestQueue;
        const redelivered = yield* replacement
          .take((payload, { attempts }) => Effect.succeed({ payload, attempts }))
          .pipe(Effect.timeoutOption("5 seconds"));
        expect(Option.isSome(redelivered)).toBe(true);
        if (Option.isSome(redelivered)) {
          expect(redelivered.value.payload).toEqual({ note: "lost" });
          expect(redelivered.value.attempts).toBe(0);
        }
        const admin = yield* MigrationSqlClient;
        const rows = yield* admin`SELECT attempts, completed
          FROM ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
          WHERE queue_name = ${testQueueName} AND id = 'health-test-lost'`;
        expect(rows).toEqual([{ attempts: 1, completed: true }]);
      })
    );

    it.effect("releases gracefully shut down work without consuming a retry attempt", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-test-graceful", { element: '{"note":"graceful"}' });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* buildTestQueue;
            const entered = yield* Deferred.make<void>();
            const holdUntilShutdown = (): Effect.Effect<never> =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
            yield* queue.take(holdUntilShutdown).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
          })
        );
        const admin = yield* MigrationSqlClient;
        const released = yield* admin`SELECT attempts, completed, acquired_by IS NULL AS "released"
          FROM ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
          WHERE queue_name = ${testQueueName} AND id = 'health-test-graceful'`;
        expect(released).toEqual([{ attempts: 0, completed: false, released: true }]);
        const replacement = yield* buildTestQueue;
        const recovered = yield* replacement
          .take((payload) => Effect.succeed(payload))
          .pipe(Effect.timeoutOption("5 seconds"));
        expect(recovered).toEqual(Option.some({ note: "graceful" }));
      })
    );

    it.effect("counts native decode failures as attempts without exposing payload bytes", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* insertTestRow({
          id: "health-test-broken",
          element: '{"note":null}',
          attempts: 0,
          lastFailure: Option.none(),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        const queue = yield* buildTestQueue;
        const error = yield* queue.take(Effect.succeed, { maxAttempts: 10 }).pipe(Effect.flip);
        expect(Schema.isSchemaError(error)).toBe(true);
        const admin = yield* MigrationSqlClient;
        const rows = yield* admin`SELECT attempts, completed
          FROM ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
          WHERE queue_name = ${testQueueName} AND id = 'health-test-broken'`;
        expect(rows).toEqual([{ attempts: 1, completed: false }]);
        const exhausted = yield* queue
          .take(Effect.succeed, { maxAttempts: 1 })
          .pipe(Effect.timeoutOption("500 millis"));
        expect(Option.isNone(exhausted)).toBe(true);
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        const row = queues.find((candidate) => candidate.queueName === testQueueName);
        expect(row?.failedCount).toBe(1);
        expect(row?.redeliveredCount).toBe(1);
        // The store records native decode failures as `Cause.pretty(SchemaError)`, so the bounded
        // `SchemaError:` prefix match confirms them per queue without reading failure text.
        expect(row?.decodeFailureCount).toBe(1);
        if (row !== undefined) {
          expect(Object.keys(row).sort()).toEqual(healthKeys);
          expect(classifyDurableQueueAttention(row)).toEqual({
            backlog: false,
            leaseChurn: false,
            exhausted: false,
            decodeFailure: true,
          });
          expectNoSentinels(Object.values(row));
        }
        const { transactions } = yield* runObservedProbe([testQueueName]);
        expect(transactions[0]?.tags.outcome).toBe("rejected");
        expect(transactions[0]?.tags.retryable).toBe("false");
      })
    );

    it.effect("reports bounded counts without payload or User dimensions", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* insertTestRow({
          id: "health-sentinel-pending",
          element: '{"note":"sentinel-secret-phrase","userId":"sentinel-user-id"}',
          attempts: 2,
          lastFailure: Option.none(),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        yield* insertTestRow({
          id: "health-sentinel-failed",
          element: '{"note":"sentinel-secret-phrase"}',
          attempts: 1,
          lastFailure: Option.some("sentinel-failure-text"),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        yield* insertTestRow({
          id: "health-sentinel-decode",
          element: '{"note":"sentinel-secret-phrase"}',
          attempts: 3,
          lastFailure: Option.some(durableQueueSchemaIncompatibleMarker),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        expect(queues).toHaveLength(1);
        const row = queues.find((candidate) => candidate.queueName === testQueueName);
        if (row === undefined) throw new Error("missing durable queue health row");
        expect(row.pendingDepth).toBe(3);
        expect(row.redeliveredCount).toBe(3);
        expect(row.failedCount).toBe(2);
        expect(row.decodeFailureCount).toBe(1);
        expect(row.exhaustedCount).toBe(0);
        expect(Object.keys(row).sort()).toEqual(healthKeys);
        const readiness = projectDurableQueueReadiness(queues);
        const attention = classifyDurableQueueAttention(row);
        expect(attention).toEqual({
          backlog: false,
          leaseChurn: false,
          exhausted: false,
          decodeFailure: true,
        });
        expect(readiness.queues[0]?.attention).toEqual(attention);
        const annotations = durableQueueAttentionLogAnnotations({ ...row, attention });
        expect(Object.keys(annotations).sort()).toEqual(attentionAnnotationKeys);
        expectNoSentinels(Object.values(annotations));
        expectNoSentinels(Object.values(readiness));

        const { transactions, serialized } = yield* runObservedProbe([testQueueName]);
        expect(transactions).toHaveLength(1);
        const transaction = transactions[0];
        if (transaction === undefined) {
          throw new Error("missing durable queue health transaction");
        }
        expect(transaction.tags).toEqual({
          component: "postgres",
          operation: "task.durableQueueHealth",
          trigger: "schedule",
          work_kind: "scheduled_execution",
          outcome: "rejected",
          retryable: "false",
          error: "operational_failure",
        });
        expect(transaction.contexts.trace.status).toBe("invalid_argument");
        expect(serialized).not.toContain("sentinel");
      })
    );

    it.effect(
      "flags exhausted and schema-incompatible work separately from transient backlog",
      () =>
        Effect.gen(function* () {
          yield* clearTestQueue;
          yield* pendingRow("health-aged-pending", { createdMinutesAgo: 20 });
          yield* pendingRow("health-stale-lease", {
            acquiredBy: Option.some(lostWorkerId),
            acquiredMinutesAgo: Option.some(20),
          });
          yield* insertTestRow({
            id: "health-exhausted",
            element: '{"note":"exhausted"}',
            attempts: 10,
            lastFailure: Option.some("Error: boom"),
            acquiredBy: Option.none(),
            acquiredMinutesAgo: Option.none(),
            createdMinutesAgo: 0,
          });
          yield* insertTestRow({
            id: "health-decode-failed",
            element: '{"note":"broken"}',
            attempts: 5,
            lastFailure: Option.some(durableQueueSchemaIncompatibleMarker),
            acquiredBy: Option.none(),
            acquiredMinutesAgo: Option.none(),
            createdMinutesAgo: 0,
          });
          const queues = yield* getDurableQueueHealthFor([testQueueName]);
          const row = queues.find((candidate) => candidate.queueName === testQueueName);
          expect(row?.pendingDepth).toBe(3);
          expect(row?.staleLeaseCount).toBe(1);
          expect(row?.stalledLeaseCount).toBe(0);
          expect(row?.exhaustedCount).toBe(1);
          expect(row?.decodeFailureCount).toBe(1);
          const readiness = projectDurableQueueReadiness(queues);
          expect(readiness.queues).toHaveLength(1);
          expect(readiness.queues[0]?.attention).toEqual({
            backlog: true,
            leaseChurn: true,
            exhausted: true,
            decodeFailure: true,
          });
        })
    );

    it.effect("reports an active lease that missed refreshes before it expires as churn", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-stalled-lease", {
          acquiredBy: Option.some(lostWorkerId),
          // Two minutes old: past the two-missed-refresh stall window (60s), inside expiry (600s).
          acquiredMinutesAgo: Option.some(2),
        });
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        const row = queues.find((candidate) => candidate.queueName === testQueueName);
        expect(row?.activeLeaseCount).toBe(1);
        expect(row?.stalledLeaseCount).toBe(1);
        expect(row?.staleLeaseCount).toBe(0);
        if (row !== undefined) {
          expect(classifyDurableQueueAttention(row)).toEqual({
            backlog: false,
            leaseChurn: true,
            exhausted: false,
            decodeFailure: false,
          });
        }
      })
    );

    it.effect("reports retained completed history without raising attention", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-retained");
        const admin = yield* MigrationSqlClient;
        yield* admin`UPDATE ${admin.literal(`fidy_durable.${durableQueueTableName}`)}
          SET completed = TRUE, updated_at = now() - interval '30 minutes'
          WHERE queue_name = ${testQueueName} AND id = 'health-retained'`;
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        const row = queues.find((candidate) => candidate.queueName === testQueueName);
        expect(row?.pendingDepth).toBe(0);
        expect(row?.retainedCount).toBe(1);
        expect(row?.oldestRetainedAgeSeconds).toBeGreaterThanOrEqual(1800);
        if (row !== undefined) {
          expect(classifyDurableQueueAttention(row)).toEqual({
            backlog: false,
            leaseChurn: false,
            exhausted: false,
            decodeFailure: false,
          });
        }
      })
    );

    it.effect("declares transient backlog as a retryable failure", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-transient", { createdMinutesAgo: 20 });
        const { transactions } = yield* runObservedProbe([testQueueName]);
        expect(transactions).toHaveLength(1);
        const transaction = transactions[0];
        expect(transaction?.tags.outcome).toBe("failed");
        expect(transaction?.tags.retryable).toBe("true");
        expect(transaction?.tags.error).toBe("operational_failure");
        expect(transaction?.contexts.trace.status).toBe("internal_error");
      })
    );

    it.effect("outranks transient backlog with permanently ineligible work", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-mixed-transient", { createdMinutesAgo: 20 });
        yield* insertTestRow({
          id: "health-mixed-permanent",
          element: '{"note":"permanent"}',
          attempts: 10,
          lastFailure: Option.some("Error: boom"),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        const { transactions } = yield* runObservedProbe([testQueueName]);
        expect(transactions).toHaveLength(1);
        const transaction = transactions[0];
        expect(transaction?.tags.outcome).toBe("rejected");
        expect(transaction?.tags.retryable).toBe("false");
        expect(transaction?.tags.error).toBe("operational_failure");
        expect(transaction?.contexts.trace.status).toBe("invalid_argument");
      })
    );

    it.effect("stays silent and successful when every observed queue is healthy", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-quiet");
        const { transactions } = yield* runObservedProbe([testQueueName]);
        expect(transactions).toHaveLength(1);
        const transaction = transactions[0];
        expect(transaction?.tags.outcome).toBe("succeeded");
        expect(transaction?.tags.retryable).toBe("false");
        expect(transaction?.tags.error).toBeUndefined();
        expect(transaction?.contexts.trace.status).toBe("ok");
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        expect(projectDurableQueueReadiness(queues).queues[0]?.attention).toEqual({
          backlog: false,
          leaseChurn: false,
          exhausted: false,
          decodeFailure: false,
        });
      })
    );
  }
);
