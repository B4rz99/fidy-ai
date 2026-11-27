import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { maintenanceName, registerLifetimeUrl, watchdogUrl } from "./contract";

const held = "22610000-0000-4000-8000-000000000001";

const healthy = "22610000-0000-4000-8000-000000000002";

type Stub = ReturnType<Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>["getByName"]>;

type Round = Readonly<{
  maintenance: Stub;
  registry: Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;
  stalled: Stub;
  now: number;
}>;

const registerAt =
  (maintenance: Stub, now: number): ((name: string) => Effect.Effect<number>) =>
  (name) =>
    native(() =>
      maintenance.fetch(registerLifetimeUrl, {
        method: "POST",
        headers: { "fidy-user-id": name, "fidy-registration-issued-ms": String(now) },
      })
    ).pipe(Effect.map(({ status }) => status));

const deliverRound = ({
  maintenance,
  registry,
  stalled,
  now,
}: Round): ((delivery: number) => Effect.Effect<void>) =>
  Effect.fnUntraced(function* (delivery) {
    yield* native(() => registry.exec("UPDATE watchdog_progress SET minute=-1"));

    yield* native(() =>
      registry.exec(
        "INSERT INTO user_recovery VALUES(?,?,?,1),(?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET due_ms=excluded.due_ms",
        held,
        held,
        now,
        healthy,
        healthy,
        now
      )
    );

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
      {
        attempted: delivery === 1 ? 5 : 4,
        observed: delivery === 1 ? 4 : 3,
        failed: 0,
        unknown: 1,
        wraps: delivery,
      },
    ]);

    const heldChecks = yield* native(() => stalled.fetch("https://fixture.invalid/held-checks"));

    const observed = yield* native(() => heldChecks.json());
    expect(observed).toEqual({ admitted: delivery, aborted: delivery, active: 0 });
  });

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

        expect(yield* Effect.forEach([held, healthy], registerAt(maintenance, now))).toEqual([
          204, 204,
        ]);

        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
        );

        yield* Effect.forEach([1, 2], deliverRound({ maintenance, registry, stalled, now }), {
          discard: true,
        });
      })
  );
});
