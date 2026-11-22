import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { expect } from "vitest";
import { alice } from "../financial-user-store.test-fixture";
import { native, nativeUserPlatform } from "../user-store.test-fixture";
import { releaseProbeName } from "../runtime/sqlite/contract";

const probe = "https://store.invalid/release-transaction";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "proves a committed native write and rollback only in the reserved release User object",
    () =>
      Effect.gen(function* () {
        const platform = yield* nativeUserPlatform;
        const runtime = yield* platform();
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const result = yield* native(() =>
          users.getByName(releaseProbeName).fetch(probe, { method: "POST" })
        );

        expect(result.status).toBe(204);

        const other = yield* native(() =>
          users.getByName(alice.user).fetch(probe, { method: "POST" })
        );

        expect(other.ok).toBe(false);

        const storage = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: releaseProbeName })
        );

        expect(yield* native(() => storage.exec("SELECT count(*) AS n FROM users"))).toEqual([
          { n: 0 },
        ]);
        expect(
          yield* native(() =>
            storage.exec("SELECT count(*) AS n FROM sqlite_schema WHERE name='fidy_release_probe'")
          )
        ).toEqual([{ n: 0 }]);
      })
  );
});
