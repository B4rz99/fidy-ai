import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { type Cause, Clock, Effect, Schedule } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, nativeBrowserPlatform, nativeUserPlatform } from "../user-store.test-fixture";

const user = "22530000-0000-4000-8000-000000000001";

const coveredUser = "22550000-0000-4000-8000-000000000088";

type MaintenanceStorage = Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;

type MaintenanceNamespace = Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>;

const coverageAt = (
  registry: MaintenanceStorage,
  maintenanceNamespace: MaintenanceNamespace,
  logs: readonly string[]
): ((coverage: readonly [number, string]) => Effect.Effect<void, Cause.TimeoutError>) =>
  Effect.fnUntraced(function* ([age, severity]: readonly [number, string]) {
    const now = yield* Clock.currentTimeMillis;
    const logged = logs.length;
    yield* native(() =>
      registry.exec(
        "UPDATE lifetime_registry SET registered_ms=?,observed_ms=0 WHERE user_id=?",
        now - age,
        coveredUser
      )
    );
    yield* native(() =>
      registry.exec(
        "UPDATE watchdog_progress SET minute=-1,scheduled=-1,started_ms=?,wrapped_at=?",
        now - age,
        now
      )
    );

    const tick = yield* native(() =>
      maintenanceNamespace
        .getByName("core-maintenance-v1")
        .fetch("https://maintenance.invalid/watchdog", {
          method: "POST",
          headers: { "x-maintenance-scheduled-at": String(now) },
        })
    );

    expect(tick.status).toBe(204);

    const coverage =
      "fidy.operational component=watchdog operation=coverage state=wrapped severity=" + severity;

    yield* Effect.sync(() => logs.slice(logged).some((line) => line.includes(coverage))).pipe(
      Effect.repeat({ until: (observed) => observed, schedule: Schedule.spaced("25 millis") }),
      Effect.timeout("3 seconds")
    );
  });

const maintenance = Effect.fn(function* (runtime: Miniflare) {
  const namespace = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));

  return namespace.getByName("core-maintenance-v1");
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "coalesces overlapping ticks, recovers committed work through a missing User alarm and reports unavailable owners",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeUserPlatform;
        const runtime = yield* start();
        const executor = yield* maintenance(runtime);
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const now = yield* Clock.currentTimeMillis;
        yield* native(() => users.getByName(user).fetch("https://user.invalid/transactions"));

        const local = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
        );

        expect(
          (yield* native(() =>
            executor.fetch("https://maintenance.invalid/lifetime/register", {
              method: "POST",
              headers: { "fidy-user-id": user, "fidy-registration-issued-ms": String(now) },
            })
          )).status
        ).toBe(204);
        yield* native(() =>
          local.exec(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,lifetime_registered) VALUES (?,'CO','es-CO','America/Bogota',0,1)",
            user
          )
        );
        yield* native(() =>
          local.exec(
            "INSERT INTO canonical_request_receipts VALUES (?,?, 'transactions.createTransaction',?,0,200,NULL)",
            user,
            "a".repeat(64),
            "b".repeat(64)
          )
        );

        const tick = (): ReturnType<typeof executor.fetch> =>
          executor.fetch("https://maintenance.invalid/watchdog", {
            method: "POST",
            headers: { "x-maintenance-scheduled-at": String(now) },
          });

        const responses = yield* native(() => Promise.all([tick(), tick()]));
        expect(responses.map((response) => response.status)).toEqual([204, 204]);

        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
            name: "core-maintenance-v1",
          })
        );

        expect(
          yield* native(() =>
            registry.exec(
              "SELECT attempted,observed,failed,unsupported,unknown,repaired,wraps FROM watchdog_progress"
            )
          )
        ).toEqual([
          {
            attempted: 4,
            observed: 4,
            failed: 0,
            unsupported: 0,
            unknown: 0,
            repaired: 1,
            wraps: 1,
          },
        ]);
        yield* native(() =>
          local.exec("SELECT retry_key_digest FROM canonical_request_receipts")
        ).pipe(
          Effect.repeat({
            until: (rows) => rows.length === 0,
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("5 seconds")
        );
      })
  );
  test.effect(
    "preserves an earlier repaired wake and inspects shared owners independently of unavailable continuations",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeUserPlatform;
        const runtime = yield* start();
        const now = yield* Clock.currentTimeMillis;

        const directory = (yield* native(() =>
          runtime.getDurableObjectNamespace("DIRECTORY", "core")
        )).getByName("directory-v1");

        const pricing = (yield* native(() =>
          runtime.getDurableObjectNamespace("PRICING", "core")
        )).getByName("pricing");

        const erasure = (yield* native(() =>
          runtime.getDurableObjectNamespace("ERASURE", "core")
        )).getByName("erasure-registry-v1");

        const check = (
          owner: typeof directory
        ): Effect.Effect<Awaited<ReturnType<typeof owner.fetch>>> =>
          native(() => owner.fetch("https://owner.internal/work/check", { method: "POST" }));

        expect((yield* check(directory)).status).toBe(204);

        const local = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        yield* native(() =>
          local.exec(
            "INSERT INTO unresolved_source_buckets(subject,virtual_at_ms) VALUES (?,?)",
            "f".repeat(64),
            now + 3600000
          )
        );
        expect((yield* check(directory)).headers.get("fidy-alarm-repaired")).toBe("1");
        expect((yield* check(directory)).headers.get("fidy-alarm-repaired")).toBe("0");
        expect((yield* check(pricing)).status).toBe(204);

        const registration = {
          operationId: "22530000-0000-4000-8000-000000000002",
          userId: user,
          billingPeriod: "weekly",
          admission: {
            kind: "renewal",
            previousPaidAttemptId: "22530000-0000-4000-8000-000000000003",
          },
          inputsDigest: "a".repeat(64),
          deadlineMs: now + 60000,
        };

        const response = yield* native(() =>
          pricing.fetch("https://pricing.invalid/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(registration),
          })
        );

        expect(response.status).toBe(200);
        expect(yield* native(() => response.json())).toMatchObject(registration);
        const scheduled = yield* check(pricing);
        expect(scheduled.status).toBe(204);
        expect(scheduled.headers.get("fidy-alarm-repaired")).toBe("0");
        expect((yield* check(erasure)).status).toBe(204);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "warns at five minutes, escalates by ten and retains unknown schema coverage after a completed wrap",
    () =>
      Effect.gen(function* () {
        const logs: string[] = [];
        const runtime = yield* (yield* nativeBrowserPlatform)(undefined, logs);
        const executor = yield* maintenance(runtime);
        const now = yield* Clock.currentTimeMillis;
        yield* native(() =>
          executor.fetch("https://maintenance.invalid/watchdog", {
            method: "POST",
            headers: { "x-maintenance-scheduled-at": String(now) },
          })
        );

        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
            name: "core-maintenance-v1",
          })
        );

        const maintenanceNamespace = yield* native(() =>
          runtime.getDurableObjectNamespace("MAINTENANCE", "core")
        );

        const id = coveredUser;
        yield* native(() =>
          registry.exec("INSERT INTO lifetime_registry(user_id,registered_ms) VALUES(?,1)", id)
        );

        yield* Effect.forEach(
          [
            [290000, "none"],
            [301000, "warning"],
            [590000, "warning"],
            [601000, "critical"],
          ] as const,
          coverageAt(registry, maintenanceNamespace, logs),
          { discard: true }
        );

        expect(
          logs.filter((line) => line.includes("fidy.operational")).some((line) => line.includes(id))
        ).toBe(false);
      })
  );
  test.effect(
    "emits the monitored restricted-capacity critical signal and a native-only completed sweep",
    () =>
      Effect.gen(function* () {
        const logs: string[] = [];
        const runtime = yield* (yield* nativeBrowserPlatform)("1", logs);
        const ns = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));

        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
            name: "core-maintenance-v1",
          })
        );

        yield* native(() => registry.exec("UPDATE lifetime_registry SET observed_ms=0"));
        const now = yield* Clock.currentTimeMillis;
        expect(
          (yield* native(() =>
            ns.getByName("core-maintenance-v1").fetch("https://maintenance.invalid/watchdog", {
              method: "POST",
              headers: {
                "x-maintenance-scheduled-at": String(now),
                "fidy-native-inspection": "1",
              },
            })
          )).status
        ).toBe(204);
        expect(
          logs.some((line) =>
            line.includes(
              "fidy.operational component=sqlite operation=directory state=restricted severity=critical"
            )
          )
        ).toBe(true);
        expect(
          logs.some((line) =>
            line.includes(
              "fidy.operational component=inspection-coverage operation=ownerInspections state=complete"
            )
          )
        ).toBe(true);
      })
  );
});
