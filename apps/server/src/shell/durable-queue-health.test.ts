import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { type SqlError } from "effect/unstable/sql";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import {
  getDurableQueueHealthFor,
  observeDurableQueueHealthFor,
  projectDurableQueueReadiness,
} from "./durable-queue-health";
import type {
  ClassifiedFailure,
  DeclaredOutcome,
  DurableTraceContext,
  SpanDescriptor,
  TelemetryBreadcrumb,
  TelemetryHttpStatus,
  TelemetryModelUsage,
} from "./observability/protocol";
import { Telemetry, type TelemetryService } from "./observability/telemetry";

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
      tableName: "fidy_queue",
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
  yield* admin`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = ${testQueueName}`;
});

const insertTestRow = (
  input: TestRowInput
): Effect.Effect<void, SqlError.SqlError, MigrationSqlClient> =>
  Effect.gen(function* () {
    const admin = yield* MigrationSqlClient;
    yield* admin`INSERT INTO fidy_durable.fidy_queue
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

/** Scans already-enumerated helix values for leaked payload, identity, or failure text. */
const expectNoSentinels = (values: ReadonlyArray<unknown>): void => {
  for (const value of values) {
    expect(String(value)).not.toContain("sentinel");
  }
};

/** Captures declared probe outcomes while leaving wrapped work unchanged. */
const captureProbeOutcomes = Effect.gen(function* () {
  const captured = yield* Ref.make<ReadonlyArray<DeclaredOutcome>>([]);
  const stub: TelemetryService = {
    span: <A, E, R>(
      _descriptor: SpanDescriptor,
      work: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> => work,
    rootSpan: <A, E, R>(
      _descriptor: SpanDescriptor,
      work: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> => work,
    continueSpan: <A, E, R>(
      _saved: unknown,
      _descriptor: SpanDescriptor,
      work: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> => work,
    recordOutcome: (outcome) => Ref.update(captured, (outcomes) => [...outcomes, outcome]),
    recordResponseStatus: (_status: TelemetryHttpStatus) => Effect.void,
    captureFailure: (_failure: ClassifiedFailure) => Effect.void,
    addBreadcrumb: (_breadcrumb: TelemetryBreadcrumb) => Effect.void,
    recordModelUsage: (_usage: TelemetryModelUsage) => Effect.void,
    captureDurableContext: Effect.succeed(Option.none<DurableTraceContext>()),
    isActiveSpan: (_context: DurableTraceContext, _operation: SpanDescriptor["operation"]) =>
      Effect.succeed(false),
  };
  return {
    stub,
    outcomes: Ref.get(captured),
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
          FROM fidy_durable.fidy_queue
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
          FROM fidy_durable.fidy_queue
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
          FROM fidy_durable.fidy_queue
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
          FROM fidy_durable.fidy_queue
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
        if (row !== undefined) {
          expectNoSentinels([
            row.queueName,
            row.pendingDepth,
            row.oldestPendingAgeSeconds,
            row.activeLeaseCount,
            row.staleLeaseCount,
            row.redeliveredCount,
            row.failedCount,
            row.schemaIncompatibleCount,
            row.exhaustedCount,
          ]);
        }
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
        const queues = yield* getDurableQueueHealthFor([testQueueName]);
        expect(queues).toHaveLength(1);
        const row = queues.find((candidate) => candidate.queueName === testQueueName);
        expect(row?.pendingDepth).toBe(2);
        expect(row?.redeliveredCount).toBe(2);
        expect(row?.failedCount).toBe(1);
        expect(row?.exhaustedCount).toBe(0);
        expect(Object.keys(row ?? {}).sort()).toEqual(
          [
            "queueName",
            "pendingDepth",
            "oldestPendingAgeSeconds",
            "activeLeaseCount",
            "staleLeaseCount",
            "redeliveredCount",
            "failedCount",
            "schemaIncompatibleCount",
            "exhaustedCount",
          ].sort()
        );
        const readiness = projectDurableQueueReadiness(queues);
        expect(readiness.status).toBe("ok");
        for (const queue of readiness.queues) {
          expectNoSentinels([
            queue.queueName,
            queue.pendingDepth,
            queue.oldestPendingAgeSeconds,
            queue.activeLeaseCount,
            queue.staleLeaseCount,
            queue.redeliveredCount,
            queue.failedCount,
            queue.schemaIncompatibleCount,
            queue.exhaustedCount,
            readiness.status,
          ]);
        }
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
            lastFailure: Option.some("schema_incompatible"),
            acquiredBy: Option.none(),
            acquiredMinutesAgo: Option.none(),
            createdMinutesAgo: 0,
          });
          const queues = yield* getDurableQueueHealthFor([testQueueName]);
          const row = queues.find((candidate) => candidate.queueName === testQueueName);
          expect(row?.pendingDepth).toBe(3);
          expect(row?.staleLeaseCount).toBe(1);
          expect(row?.exhaustedCount).toBe(1);
          expect(row?.schemaIncompatibleCount).toBe(1);
          const readiness = projectDurableQueueReadiness(queues);
          expect(readiness.status).toBe("needs-attention");
          expect(readiness.queues).toHaveLength(1);
          expect(readiness.queues[0]?.attention).toEqual({
            backlog: true,
            leaseChurn: true,
            exhausted: true,
            decodeFailure: true,
          });
        })
    );

    it.effect("declares transient backlog as a retryable failure", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-transient", { createdMinutesAgo: 20 });
        const probe = yield* captureProbeOutcomes;
        yield* observeDurableQueueHealthFor([testQueueName]).pipe(
          Effect.provideService(Telemetry, probe.stub)
        );
        const outcomes = yield* probe.outcomes;
        expect(outcomes.length).toBe(1);
        expect(outcomes[0]?.outcome).toBe("failed");
        expect(outcomes[0]?.retryable).toBe(true);
      })
    );

    it.effect("declares permanently ineligible work as a non-retryable rejection", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* insertTestRow({
          id: "health-permanent",
          element: '{"note":"permanent"}',
          attempts: 10,
          lastFailure: Option.some("Error: boom"),
          acquiredBy: Option.none(),
          acquiredMinutesAgo: Option.none(),
          createdMinutesAgo: 0,
        });
        const probe = yield* captureProbeOutcomes;
        yield* observeDurableQueueHealthFor([testQueueName]).pipe(
          Effect.provideService(Telemetry, probe.stub)
        );
        const outcomes = yield* probe.outcomes;
        expect(outcomes.length).toBe(1);
        expect(outcomes[0]?.outcome).toBe("rejected");
        expect(outcomes[0]?.retryable).toBe(false);
      })
    );

    it.effect("stays silent when every observed queue is healthy", () =>
      Effect.gen(function* () {
        yield* clearTestQueue;
        yield* pendingRow("health-quiet");
        const probe = yield* captureProbeOutcomes;
        const queues = yield* observeDurableQueueHealthFor([testQueueName]).pipe(
          Effect.provideService(Telemetry, probe.stub)
        );
        expect(yield* probe.outcomes).toEqual([]);
        expect(projectDurableQueueReadiness(queues).status).toBe("ok");
      })
    );
  }
);
