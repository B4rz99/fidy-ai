import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { storeReadinessUrl } from "../runtime/sqlite/contract";
import { native, nativeOAuthPlatform } from "../user-store.test-fixture";

type DirectoryStorage = Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;

const saturate = (
  input: Readonly<{ storage: DirectoryStorage; scope: string; limit: number; now: number }>
): Effect.Effect<void> =>
  native(() =>
    input.storage.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO bootstrap_admissions(scope,expires_at_ms) SELECT ?,? FROM n",
      input.limit,
      input.scope,
      input.now + 60000
    )
  );

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("does not let anonymous flows refuse credentialed OAuth traffic", () =>
    Effect.gen(function* () {
      const create = yield* nativeOAuthPlatform;
      const runtime = yield* create();
      const directory = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));
      const store = directory.getByName("directory-v1");
      const ready = yield* native(() => store.fetch(storeReadinessUrl));
      expect(ready.ok).toBe(true);

      const storage = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      const now = yield* Clock.currentTimeMillis;

      type StoreReply = Awaited<ReturnType<typeof store.fetch>>;

      const refresh = (): Effect.Effect<StoreReply> =>
        native(() =>
          store.fetch("https://directory.invalid/oauth/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-oauth-source": "f".repeat(64),
            },
            body: "grant_type=refresh_token&client_id=00000000-0000-4000-8000-000000000099",
          })
        );

      const authorize = (): Effect.Effect<StoreReply> =>
        native(() =>
          store.fetch("https://directory.invalid/oauth/authorize", {
            headers: { "x-oauth-source": "f".repeat(64) },
          })
        );

      yield* saturate({ storage, now, scope: "oauth/global/bootstrap", limit: 300 });

      expect((yield* refresh()).status).not.toBe(429);
      expect((yield* authorize()).status).toBe(429);

      yield* saturate({ storage, now, scope: "oauth/global/credentialed", limit: 300 });

      const refused = yield* refresh();
      expect(refused.status).toBe(429);
      expect(yield* native(() => refused.json())).toMatchObject({ error: "slow_down" });

      yield* native(() => storage.exec("DELETE FROM bootstrap_admissions"));

      expect((yield* refresh()).status).not.toBe(429);
    })
  );
});
