import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, nativeUserPlatform } from "../user-store.test-fixture";

const original = "22380000-0000-4000-8000-000000000001";

const fresh = "22380000-0000-4000-8000-000000000002";

const erasure = "22380000-0000-4000-8000-000000000003";

const other = "22380000-0000-4000-8000-000000000004";

const registry = Effect.fn(function* (runtime: Miniflare) {
  const namespace = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));
  const owner = namespace.getByName("core-maintenance-v1");
  const now = yield* Clock.currentTimeMillis;

  const headers = (userId: string, issuedMs: number): Headers =>
    new Headers({ "fidy-user-id": userId, "fidy-registration-issued-ms": String(issuedMs) });

  const erasureHeaders = (userId: string, erasure: string): Headers => {
    const fenced = headers(userId, now);
    fenced.set("fidy-erasure-reference", erasure);

    return fenced;
  };

  const send = (action: "register" | "fence" | "retire", sent: Headers): Effect.Effect<number> =>
    native(() =>
      owner.fetch("https://maintenance.invalid/lifetime/" + action, {
        method: "POST",
        headers: sent,
      })
    ).pipe(Effect.map((response) => response.status));

  return {
    register: (userId: string, issuedMs = now): Effect.Effect<number> =>
      send("register", headers(userId, issuedMs)),
    fence: (userId: string, erasure: string): Effect.Effect<number> =>
      send("fence", erasureHeaders(userId, erasure)),
    retire: (userId: string, erasure: string): Effect.Effect<number> =>
      send("retire", erasureHeaders(userId, erasure)),
  };
});

const seedErasure = Effect.fn(function* (runtime: Miniflare) {
  const independent = (yield* native(() =>
    runtime.getDurableObjectNamespace("ERASURE", "core")
  )).getByName("erasure-registry-v1");

  yield* native(() => independent.fetch("https://owner.internal/work/check", { method: "POST" }));

  const cases = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Erasure", {
      name: "erasure-registry-v1",
    })
  );

  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    cases.exec(
      "INSERT INTO erasure_cases(user_id,reference,requested_at_ms,state,next_check_ms) VALUES(?,?,1,'Draining',?)",
      original,
      erasure,
      now + 60000
    )
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("retains idle owners and matches retirement to the exact durable erasure fence", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* create();
          const call = yield* registry(runtime);
          expect(yield* call.register(fresh, 1)).toBe(409);
          expect(yield* call.register(original)).toBe(204);
          expect(yield* call.register(original)).toBe(204);
          expect(yield* call.retire(original, erasure)).toBe(409);
          expect(yield* call.fence(original, erasure)).toBe(409);
          yield* seedErasure(runtime);
          expect(yield* call.fence(original, erasure)).toBe(204);
          expect(yield* call.fence(original, other)).toBe(409);
          expect(yield* call.register(original)).toBe(409);
        })
      );
      const runtime = yield* create();
      const call = yield* registry(runtime);
      expect(yield* call.register(fresh)).toBe(204);
      const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

      const inactive = yield* native(() =>
        users.getByName(fresh).fetch("https://user.invalid/transactions")
      );

      expect(inactive.status).toBe(401);

      const local = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: fresh })
      );

      expect(yield* native(() => local.exec("SELECT id FROM users"))).toEqual([]);
      yield* native(() =>
        local.exec(
          "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)",
          fresh
        )
      );
      yield* native(() =>
        local.exec(
          "INSERT INTO erasure_requests(id,user_id,state) VALUES (?,?,'pending')",
          other,
          fresh
        )
      );

      const check = yield* native(() =>
        users.getByName(fresh).fetch("https://owner.internal/work/check", { method: "POST" })
      );

      expect(check.status).toBe(503);
      expect(check.headers.has("fidy-alarm-repaired")).toBe(false);
      expect(yield* native(() => local.exec("SELECT lifetime_registered FROM users"))).toEqual([
        { lifetime_registered: 0 },
      ]);
      expect(yield* call.retire(fresh, erasure)).toBe(409);
      expect(yield* call.retire(original, other)).toBe(409);

      const store = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
          name: "core-maintenance-v1",
        })
      );

      const discoverable = native(() =>
        store.exec("SELECT user_id FROM lifetime_registry WHERE retired=0 ORDER BY user_id")
      );

      expect(yield* discoverable).toEqual([{ user_id: original }, { user_id: fresh }]);
      expect(yield* call.retire(original, erasure)).toBe(409);

      const independent = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Erasure", { name: "erasure-registry-v1" })
      );

      yield* native(() =>
        independent.exec(
          "UPDATE erasure_cases SET state='Complete' WHERE user_id=? AND reference=?",
          original,
          erasure
        )
      );
      expect(yield* call.retire(original, erasure)).toBe(204);
      expect(yield* call.retire(original, erasure)).toBe(204);
      expect(yield* call.register(original)).toBe(409);
      expect(yield* discoverable).toEqual([{ user_id: fresh }]);
      expect(
        yield* native(() =>
          store.exec(
            "SELECT user_id,erasure_reference,retired FROM lifetime_registry ORDER BY user_id"
          )
        )
      ).toEqual([
        { user_id: original, erasure_reference: erasure, retired: 1 },
        { user_id: fresh, erasure_reference: null, retired: 0 },
      ]);
    })
  );
});
