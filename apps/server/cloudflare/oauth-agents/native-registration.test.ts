import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { storeReadinessUrl } from "../runtime/sqlite/contract";
import { native, nativeOAuthPlatform } from "../user-store.test-fixture";

type DirectoryStorage = Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;

const day = 86_400_000;

const fillClients = (
  input: Readonly<{ storage: DirectoryStorage; created: number; lastUsed: number }>
): Effect.Effect<void> =>
  native(() =>
    input.storage.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO oauth_public_clients(id,metadata_json,created_at_ms,last_used_at_ms) SELECT printf('client-%05d',i),'{}',?,? FROM n",
      input.created,
      input.lastUsed
    )
  );

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("evicts abandoned clients so a full table does not lock out registration", () =>
    Effect.gen(function* () {
      const create = yield* nativeOAuthPlatform;
      const runtime = yield* create();
      const directory = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));
      const store = directory.getByName("directory-v1");
      const ready = yield* native(() => store.fetch(storeReadinessUrl));
      expect(ready.ok).toBe(true);
      yield* native(() => ready.arrayBuffer());

      const storage = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      const now = yield* Clock.currentTimeMillis;

      type StoreReply = Awaited<ReturnType<typeof store.fetch>>;

      const register = (): Effect.Effect<StoreReply> =>
        native(() =>
          store.fetch("https://directory.invalid/oauth/register", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-oauth-source": "a".repeat(64),
            },
            body: JSON.stringify({
              client_name: "Test client",
              redirect_uris: ["https://client.example/callback"],
            }),
          })
        );

      yield* fillClients({ storage, created: now - 2 * day, lastUsed: now - 2 * day });

      const registered = yield* register();
      expect(registered.status).toBe(201);
      yield* native(() => registered.arrayBuffer());
      expect(
        yield* native(() => storage.exec("SELECT count(*) AS n FROM oauth_public_clients"))
      ).toEqual([{ n: 9969 }]);

      yield* native(() => storage.exec("DELETE FROM oauth_public_clients"));
      yield* fillClients({ storage, created: now, lastUsed: now });

      const full = yield* register();
      expect(full.status).toBe(503);
      yield* native(() => full.arrayBuffer());

      yield* native(() => storage.exec("DELETE FROM oauth_public_clients"));
      yield* fillClients({ storage, created: now - 40 * day, lastUsed: now - 3_600_000 });

      const stale = yield* register();
      expect(stale.status).toBe(503);
      yield* native(() => stale.arrayBuffer());
    })
  );
});
