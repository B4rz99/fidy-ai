import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { maintenanceName, registerLifetimeUrl, watchdogUrl } from "./contract";

const held = "22610000-0000-4000-8000-000000000001";
const healthy = "22610000-0000-4000-8000-000000000002";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "cancels two hung native UserStore requests, records unknown outcomes and keeps checking peers",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeHostedPlatform)();
        const owners = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const namespace = yield* native(() =>
          runtime.getDurableObjectNamespace("MAINTENANCE", "core")
        );
        const maintenance = namespace.getByName(maintenanceName);
        const stalled = owners.getByName(held);
        expect(
          (yield* native(() => stalled.fetch("https://fixture.invalid/hold-check"))).status
        ).toBe(204);
        const now = yield* Clock.currentTimeMillis;
        for (const name of [held, healthy]) {
          expect(
            (yield* native(() =>
              maintenance.fetch(registerLifetimeUrl, {
                method: "POST",
                headers: { "fidy-user-id": name, "fidy-registration-issued-ms": String(now) },
              })
            )).status
          ).toBe(204);
        }
        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
        );
        for (const delivery of [1, 2]) {
          yield* native(() => registry.exec("UPDATE watchdog_progress SET minute=-1"));
          const tick = yield* native(() =>
            maintenance.fetch(watchdogUrl, {
              method: "POST",
              headers: { "x-maintenance-scheduled-at": String(now + delivery) },
            })
          );
          expect(tick.status).toBe(204);
          const progress = yield* native(() =>
            registry.exec("SELECT attempted,observed,failed,unknown,wraps FROM watchdog_progress")
          );
          expect(progress).toEqual([
            { attempted: 5, observed: 4, failed: 0, unknown: 1, wraps: delivery },
          ]);
          const heldChecks = yield* native(() =>
            stalled.fetch("https://fixture.invalid/held-checks")
          );
          const observed = yield* native(() => heldChecks.json());
          expect(observed).toEqual({ admitted: delivery, aborted: delivery, active: 0 });
        }
      }),
    25000
  );
});
