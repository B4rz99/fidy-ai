import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Result, Schedule } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, nativeFleetPlatform } from "../user-store.test-fixture";
import { maintenanceName, watchdogUrl } from "./contract";

const user = "22530000-0000-4000-8000-000000000091";

const prepareCrash = Effect.fn(function* (runtime: Miniflare) {
  const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const maintenance = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));
  const store = users.getByName(user);
  yield* native(() => store.fetch("https://user.invalid/transactions"));

  const storage = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
  );

  const registry = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
  );

  const registered = maintenance.getByName(maintenanceName);
  const now = yield* Clock.currentTimeMillis;
  expect(
    (yield* native(() =>
      registered.fetch("https://maintenance.invalid/lifetime/register", {
        method: "POST",
        headers: { "fidy-user-id": user, "fidy-registration-issued-ms": String(now) },
      })
    )).status
  ).toBe(204);
  yield* native(() =>
    storage.exec(
      "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,lifetime_registered) VALUES (?,'CO','es-CO','America/Bogota',0,1)",
      user
    )
  );

  const crashed = yield* Effect.tryPromise(() =>
    store.fetch("https://fixture.invalid/commit-then-crash")
  ).pipe(Effect.result);

  expect(Result.isFailure(crashed) || crashed.success.status >= 500).toBe(true);
  expect(
    yield* native(() => storage.exec("SELECT accepted_at_ms FROM canonical_request_receipts"))
  ).toEqual([{ accepted_at_ms: 0 }]);
  expect(
    yield* native(() => registry.exec("SELECT uncertain FROM user_recovery WHERE user_id=?", user))
  ).toEqual([{ uncertain: 1 }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("recovers a committed receipt after an abort before its alarm was armed", () =>
    Effect.gen(function* () {
      const start = yield* nativeFleetPlatform;
      yield* Effect.scoped(Effect.flatMap(start(), prepareCrash));

      const runtime = yield* start();

      const maintenance = yield* native(() =>
        runtime.getDurableObjectNamespace("MAINTENANCE", "core")
      );

      const registry = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
      );

      const storage = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
      );

      const now = yield* Clock.currentTimeMillis;
      const executor = maintenance.getByName(maintenanceName);

      const tick = (): ReturnType<typeof executor.fetch> =>
        executor.fetch(watchdogUrl, {
          method: "POST",
          headers: { "x-maintenance-scheduled-at": String(now + 180000) },
        });

      expect((yield* native(tick)).status).toBe(204);
      yield* native(() =>
        storage.exec("SELECT 1 AS retained FROM canonical_request_receipts")
      ).pipe(
        Effect.repeat({
          until: (rows) => rows.length === 0,
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("5 seconds")
      );
      expect(
        yield* native(() => storage.exec("SELECT 1 AS retained FROM canonical_request_receipts"))
      ).toEqual([]);
      expect(
        yield* native(() =>
          registry.exec("SELECT recovery_seeded FROM lifetime_registry WHERE user_id=?", user)
        )
      ).toEqual([{ recovery_seeded: 1 }]);
    })
  );
});
