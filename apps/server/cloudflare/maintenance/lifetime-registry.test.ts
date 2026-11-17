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
  return (
    action: "register" | "fence" | "retire",
    userId: string,
    detail?: string | number
  ): Effect.Effect<number> =>
    native(() =>
      owner.fetch("https://maintenance.invalid/lifetime/" + action, {
        method: "POST",
        headers: {
          "fidy-user-id": userId,
          "fidy-registration-issued-ms": String(typeof detail === "number" ? detail : now),
          ...(typeof detail === "string" ? { "fidy-erasure-reference": detail } : {}),
        },
      })
    ).pipe(Effect.map((response) => response.status));
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("retains idle owners and matches retirement to the exact durable erasure fence", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* create();
          const call = yield* registry(runtime);
          expect(yield* call("register", fresh, 1)).toBe(409);
          expect(yield* call("register", original)).toBe(204);
          expect(yield* call("register", original)).toBe(204);
          expect(yield* call("retire", original, erasure)).toBe(409);
          expect(yield* call("fence", original, erasure)).toBe(204);
          expect(yield* call("fence", original, other)).toBe(409);
          expect(yield* call("register", original)).toBe(409);
        })
      );
      const runtime = yield* create();
      const call = yield* registry(runtime);
      expect(yield* call("register", fresh)).toBe(204);
      const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
      const inactive = yield* native(() =>
        users.getByName(fresh).fetch("https://user.invalid/transactions")
      );
      expect(inactive.status).toBe(401);
      const local = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: fresh })
      );
      expect(yield* native(() => local.exec("SELECT id FROM users"))).toEqual([]);
      expect(yield* call("retire", fresh, erasure)).toBe(409);
      expect(yield* call("retire", original, other)).toBe(409);
      const store = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
          name: "core-maintenance-v1",
        })
      );
      const discoverable = native(() =>
        store.exec("SELECT user_id FROM lifetime_registry WHERE retired=0 ORDER BY user_id")
      );
      expect(yield* discoverable).toEqual([{ user_id: original }, { user_id: fresh }]);
      expect(yield* call("retire", original, erasure)).toBe(204);
      expect(yield* call("retire", original, erasure)).toBe(204);
      expect(yield* call("register", original)).toBe(409);
      expect(yield* discoverable).toEqual([{ user_id: fresh }]);
    })
  );
});
