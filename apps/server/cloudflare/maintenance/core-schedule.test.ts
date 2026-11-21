import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect } from "effect";
import { expect } from "vitest";
import { native, nativeUserPlatform } from "../user-store.test-fixture";
import { storeReadinessUrl } from "../runtime/sqlite/contract";
import { maintenanceName } from "./contract";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) =>
  test.effect(
    "runs the installed Core cron through the native Maintenance owner, coalesces repeat delivery and respects isolation",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeUserPlatform;
        const scheduledTime = yield* Clock.currentTimeMillis;
        const runtime = yield* start();
        const core = yield* native(() => runtime.getWorker("core"));

        const deliver = native(() =>
          core.scheduled({
            cron: "* * * * *",
            scheduledTime: DateTime.toDate(DateTime.makeUnsafe(scheduledTime)),
          })
        );

        expect((yield* deliver).outcome).toBe("ok");
        expect((yield* deliver).outcome).toBe("ok");

        const progress = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
        );

        const snapshot = (): ReturnType<typeof progress.exec> =>
          progress.exec(
            "SELECT scheduled,wraps,shared_observed,failed,unknown FROM watchdog_progress"
          );

        const recorded = yield* native(snapshot);
        expect(recorded).toEqual([
          { scheduled: scheduledTime, wraps: 1, shared_observed: 3, failed: 0, unknown: 0 },
        ]);
        yield* native(() => runtime.dispose());
        const closed = yield* start("1000000000", [], { RECOVERY_ISOLATION: "isolated" });
        const held = yield* native(() => closed.getWorker("core"));
        yield* native(() =>
          held.scheduled({
            cron: "* * * * *",
            scheduledTime: DateTime.toDate(DateTime.makeUnsafe(scheduledTime + 60000)),
          })
        );
        const owners = yield* native(() => closed.getDurableObjectNamespace("MAINTENANCE", "core"));
        expect(
          (yield* native(() => owners.getByName(maintenanceName).fetch(storeReadinessUrl))).ok
        ).toBe(true);

        const retained = yield* native(() =>
          closed.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
        );

        expect(
          yield* native(() =>
            retained.exec(
              "SELECT scheduled,wraps,shared_observed,failed,unknown FROM watchdog_progress"
            )
          )
        ).toEqual(recorded);
      })
  )
);
