import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule } from "effect";
import { expect } from "vitest";
import { directoryName, sourcePressureUrl } from "../directory/contract";
import { native, nativeFleetPlatform } from "../user-store.test-fixture";
import { maintenanceName, recoveryGraceMs, watchdogUrl } from "./contract";

const futureSource = "b".repeat(64);

const observedSource = "a".repeat(64);

const verifyDirectoryRecovery = Effect.gen(function* () {
  const start = yield* nativeFleetPlatform;
  const runtime = yield* start();

  const directories = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));

  const owners = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));
  const directory = directories.getByName(directoryName);
  const maintenance = owners.getByName(maintenanceName);

  const index = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
  );

  const scheduled = yield* Clock.currentTimeMillis;

  const tick = (now: number): Effect.Effect<number> =>
    native(() =>
      maintenance.fetch(watchdogUrl, {
        method: "POST",
        headers: { "x-maintenance-scheduled-at": String(now) },
      })
    ).pipe(Effect.map((response) => response.status));

  const probes = native(() =>
    maintenance.fetch("https://fixture.invalid/fleet-observations").then((reply) => reply.json())
  );

  expect(yield* tick(scheduled)).toBe(204);
  yield* probes;

  yield* native(() => index.exec("UPDATE watchdog_progress SET minute=-1"));
  expect(yield* tick(scheduled + 60_000)).toBe(204);
  expect(yield* probes).toMatchObject({
    probes: [{ name: "pricing" }, { name: "erasure-registry-v1" }],
  });

  const storage = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: directoryName })
  );

  const future = scheduled + 180_000;
  const initialExpiry = (yield* Clock.currentTimeMillis) + 700;
  yield* native(() =>
    storage.exec(
      "INSERT INTO unresolved_source_buckets VALUES(?,?),(?,?)",
      futureSource,
      future,
      observedSource,
      initialExpiry
    )
  );
  expect(
    (yield* native(() =>
      directory.fetch(sourcePressureUrl, { method: "POST", body: observedSource })
    )).status
  ).toBe(204);

  yield* native(() => index.exec("SELECT due_ms FROM directory_recovery")).pipe(
    Effect.repeat({
      until: (rows) => rows[0]?.due_ms === future + recoveryGraceMs,
      schedule: Schedule.spaced("25 millis"),
    }),
    Effect.timeout("4 seconds")
  );
  expect(
    yield* native(() => storage.exec("SELECT subject FROM unresolved_source_buckets"))
  ).toEqual([{ subject: futureSource }]);

  expect(
    (yield* native(() => directory.fetch("https://fixture.invalid/remove-directory-alarm"))).status
  ).toBe(204);
  yield* native(() => storage.exec("UPDATE unresolved_source_buckets SET virtual_at_ms=0"));
  yield* native(() => index.exec("UPDATE watchdog_progress SET minute=-1"));
  expect(yield* tick(future + recoveryGraceMs - 1)).toBe(204);
  expect(yield* probes).toMatchObject({
    probes: [{ name: "pricing" }, { name: "erasure-registry-v1" }],
  });

  yield* native(() => index.exec("UPDATE watchdog_progress SET minute=-1"));
  expect(yield* tick(future + recoveryGraceMs)).toBe(204);
  expect(yield* probes).toMatchObject({
    probes: [{ name: directoryName }, { name: "pricing" }, { name: "erasure-registry-v1" }],
  });
  yield* native(() => storage.exec("SELECT subject FROM unresolved_source_buckets")).pipe(
    Effect.repeat({
      until: (rows) => rows.length === 0,
      schedule: Schedule.spaced("25 millis"),
    }),
    Effect.timeout("4 seconds")
  );

  yield* native(() => index.exec("SELECT due_ms FROM directory_recovery")).pipe(
    Effect.repeat({
      until: (rows) => rows[0]?.due_ms === null,
      schedule: Schedule.spaced("25 millis"),
    }),
    Effect.timeout("4 seconds")
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "leaves idle Directory asleep and repairs a missing cleanup alarm when overdue",
    () => verifyDirectoryRecovery
  );
});
