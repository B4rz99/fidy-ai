import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { storeReadinessUrl } from "../runtime/sqlite/contract";
import { native, nativeOAuthPlatform } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("caps concurrent OAuth leases per source while other sources stay admitted", () =>
    Effect.gen(function* () {
      const create = yield* nativeOAuthPlatform;
      const runtime = yield* create();
      const directory = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));
      const store = directory.getByName("directory-v1");
      const ready = yield* native(() => store.fetch(storeReadinessUrl));
      expect(ready.ok).toBe(true);
      const capped = "a".repeat(64);
      const other = "b".repeat(64);
      const storage = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );
      const now = yield* Clock.currentTimeMillis;
      for (let index = 0; index < 8; index += 1) {
        yield* native(() =>
          storage.exec(
            "INSERT INTO oauth_leases(id,expires_at_ms,source) VALUES(?,?,?)",
            "lease-" + index,
            now + 10_000,
            capped
          )
        );
      }
      type LeaseReply = Awaited<ReturnType<typeof store.fetch>>;
      const dispatch = (source: string): Effect.Effect<LeaseReply> =>
        native(() =>
          store.fetch("https://directory.invalid/oauth/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-oauth-source": source,
            },
            body: "grant_type=refresh_token&client_id=00000000-0000-4000-8000-000000000099",
          })
        );
      const held = yield* dispatch(capped);
      expect(held.status).toBe(429);
      expect(yield* native(() => held.json())).toMatchObject({ error: "slow_down" });
      const admitted = yield* dispatch(other);
      expect(admitted.status).toBe(400);
      expect(yield* native(() => admitted.json())).toMatchObject({ error: "invalid_grant" });
    })
  );
});
