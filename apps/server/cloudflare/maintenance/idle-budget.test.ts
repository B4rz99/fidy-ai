import { Clock, Effect, Logger, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage, observeRetentionCost } from "../d1-test-fixture";
import {
  maintenancePerformanceDatabase,
  maintenancePerformanceEnvironment,
} from "../maintenance-performance.test-fixture";
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
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
        let current = 86_405_000;
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
        const measured = observeRetentionCost(db);
        const guarded = maintenancePerformanceDatabase({ db: measured.database, bucket });
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
        for (let minute = 1; minute <= 60; minute++) {
          current += 60_000;
          yield* tick;
        }
        const total = measured.cost();
        const dailyWrites = (total.rowsWritten - warm.rowsWritten) * 24 + warm.rowsWritten;
        expect(dailyWrites).toBeLessThan(10_000);
        expect((total.rowsRead - warm.rowsRead) * 24 + warm.rowsRead).toBeLessThan(750_000);
        expect(queueOffers - warmOffers).toBe(12);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS n FROM erasure_control WHERE kind IN ('email','statement','erasure')"
              )
              .first("n")
          )
        ).toBe(0);
      })
    ),
  60_000
);
