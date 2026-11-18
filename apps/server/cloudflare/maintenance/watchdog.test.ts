import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, nativeUserPlatform } from "../user-store.test-fixture";

const user = "22530000-0000-4000-8000-000000000001";
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
            observed: 3,
            failed: 0,
            unsupported: 1,
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
      }),
    25000
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
        yield* native(() => response.text());
        expect((yield* check(pricing)).status).toBe(503);
        expect((yield* check(erasure)).status).toBe(404);
      })
  );
});
