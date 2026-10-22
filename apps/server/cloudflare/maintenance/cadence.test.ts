import { Clock, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { maintenancePerformanceEnvironment } from "../maintenance-performance.test-fixture";
import { runCoreMaintenance } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());

it("waits for hourly cleanup before removing expired grants and preserves current grants", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms) VALUES ('workers-ai-expired','test','operation','test','rolling_window',1,1,1,2,NULL)"
          ),
          db.prepare("INSERT INTO resource_admission_grants VALUES ('workers-ai-expired',1,1)"),
          db
            .prepare(
              "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms) VALUES ('workers-ai-current','test','operation','test','rolling_window',1,?,?,?,NULL)"
            )
            .bind(now, now, now + 86_400_000),
          db
            .prepare("INSERT INTO resource_admission_grants VALUES ('workers-ai-current',?,1)")
            .bind(now),
        ])
      );
      const unavailable = (): never => {
        throw new Error("Unexpected background publication");
      };
      const environment = {
        ...maintenancePerformanceEnvironment({
          db,
          bucket,
          queue: { send: unavailable, sendBatch: unavailable, metrics: unavailable },
          workflow: {
            get: unavailable,
            create: unavailable,
            createBatch: unavailable,
            deleteBatch: unavailable,
          },
        }),
        ASYNC_HEALTH_ENABLED: Option.none<"enabled">(),
      };
      yield* runCoreMaintenance({ environment, scheduledAtEpochMs: 60_000 });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM resource_admission_grants ORDER BY id").all()
        )).results
      ).toEqual([{ id: "workers-ai-current" }, { id: "workers-ai-expired" }]);
      yield* runCoreMaintenance({ environment, scheduledAtEpochMs: 3_600_000 });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM resource_admission_grants ORDER BY id").all()
        )).results
      ).toEqual([{ id: "workers-ai-current" }]);
    })
  ));
