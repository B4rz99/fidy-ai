import { Clock, Effect, Logger, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage, observeRetentionCost } from "../d1-test-fixture";
import { maintenancePerformanceEnvironment } from "../maintenance-performance.test-fixture";
import { withErasureRecovery } from "../erasure/runtime";
import { sweepErasureControlObjects } from "../erasure/operations";
import { runCoreMaintenance, runEmailMaintenance } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());

it(
  "keeps complete guarded idle maintenance below ten percent of the daily D1 write allowance",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
        yield* Effect.tryPromise(() =>
          installTestSchema({
            db,
            sources: Array.from(
              new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
            )
              .sort()
              .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
          })
        );
        yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
        let current = 3_005_000;
        const live = yield* Clock.Clock;
        const clock: Clock.Clock = {
          currentTimeMillis: Effect.sync(() => current),
          currentTimeMillisUnsafe: () => current,
          currentTimeNanos: live.currentTimeNanos,
          currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
          monotonicTimeNanos: live.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
          sleep: (duration) => live.sleep(duration),
        };
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO operational_canary VALUES ('queueExecution', ?), ('workflowExecution', ?)"
            )
            .bind(current, current)
            .run()
        );
        const measured = observeRetentionCost(db);
        const guarded = withErasureRecovery({
          DB: measured.database,
          ERASURE_REQUIRED: "true",
          ERASURE_BUCKET: bucket,
        }).DB;
        let queueOffers = 0;
        const unexpected = (): Promise<never> =>
          Promise.reject(new Error("Idle maintenance attempted product work"));
        const queue: Queue = {
          send: () => {
            queueOffers++;
            return Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
          },
          sendBatch: unexpected,
          metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
        };
        const environment = maintenancePerformanceEnvironment({
          db: guarded,
          bucket,
          queue,
          workflow: {
            get: unexpected,
            create: unexpected,
            createBatch: unexpected,
            deleteBatch: unexpected,
          },
        });
        const tick = Effect.gen(function* () {
          yield* runCoreMaintenance(environment);
          yield* runEmailMaintenance({ DB: guarded, EMAIL_BUCKET: bucket, EMAIL_QUEUE: queue });
          yield* sweepErasureControlObjects({
            db: measured.database,
            buckets: (["email", "statement", "erasure"] as const).map((id) => ({
              id,
              bucket: Option.some(bucket),
            })),
          });
        }).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provideService(Logger.CurrentLoggers, new Set())
        );
        yield* tick;
        const warm = measured.cost();
        const warmOffers = queueOffers;
        for (let minute = 1; minute <= 5; minute++) {
          current += 60_000;
          yield* tick;
        }
        const total = measured.cost();
        // Account for two downstream canary executions (up to four indexed writes each).
        const canaryWrites = (queueOffers - warmOffers) * 8;
        const dailyWrites = (total.rowsWritten - warm.rowsWritten + canaryWrites) * 288;
        expect(dailyWrites).toBeLessThan(10_000);
        expect((total.rowsRead - warm.rowsRead) * 288).toBeLessThan(750_000);
        expect(queueOffers - warmOffers).toBe(1);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS n FROM erasure_control_sweeps").first("n")
          )
        ).toBe(0);
      })
    ),
  30_000
);
