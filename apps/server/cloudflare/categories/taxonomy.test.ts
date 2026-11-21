import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Effect, FileSystem, Option, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { Miniflare } from "miniflare";
import {
  compatibleCategoryReleases,
  currentCategoryRelease,
} from "../../src/core/categories/operations";
import {
  CategoryReference,
  CategoryTaxonomyRelease,
  categoryIds,
} from "../../src/core/categories/contract";
import { native, workerManifest } from "../user-store.test-fixture";

const alice = "10000000-0000-4000-8000-000000000051";

const bob = "10000000-0000-4000-8000-000000000052";

const session = "10000000-0000-4000-8000-000000000061";

const bearer = "1".repeat(43);

const first = "10000000-0000-4000-8000-000000000081";

const second = "10000000-0000-4000-8000-000000000082";

const added = "20000000-0000-4000-8000-000000000017";

const initial = Option.getOrThrow(Option.fromUndefinedOr(currentCategoryRelease.revisions[0]));

const updated = {
  id: "co-2",
  categories: [
    ...initial.categories
      .toReversed()
      .map((category) =>
        category.id === categoryIds.mercado ? { ...category, label: "Alimentos" } : category
      ),
    { id: added, label: "Prueba" },
  ],
};

const prepared = Schema.decodeSync(CategoryTaxonomyRelease)({
  write: initial.id,
  revisions: [initial, updated],
});

const writing = Schema.decodeSync(CategoryTaxonomyRelease)({ ...prepared, write: updated.id });

const bundle = Effect.fn(function* (release: CategoryTaxonomyRelease) {
  const build = yield* native(() =>
    Bun.build({
      entrypoints: [new URL("./taxonomy.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
      plugins: [
        {
          name: "fixture-packaged-taxonomy",
          setup: (builder): void => {
            builder.onLoad({ filter: /taxonomy-release\.json$/u }, () => ({
              loader: "json",
              contents: JSON.stringify(release),
            }));
          },
        },
      ],
    })
  );

  const artifact = build.outputs[0];

  if (!build.success || artifact === undefined) {
    return yield* Effect.die(Error("Taxonomy fixture bundle failed"));
  }

  const contents = yield* native(() => artifact.text());

  return {
    mainModule: "index.mjs",
    modules: {
      "index.mjs": {
        type: "esm" as const,
        contents: "export { observerWorker as default, CategoryProbe } from './fixture.mjs'",
      },
      "fixture.mjs": { type: "esm" as const, contents },
    },
  };
});

const start = Effect.fn(function* (
  input: Readonly<{ path: string; owner: CategoryTaxonomyRelease; reader: CategoryTaxonomyRelease }>
) {
  const [owner, reader] = yield* Effect.all([bundle(input.owner), bundle(input.reader)], {
    concurrency: 2,
  });

  const registry = yield* workerManifest("./core-worker.ts");

  const bindings = {
    SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: "1000000000" },
    CF_VERSION_METADATA: { type: "version-metadata" },
    USER_STORE: { type: "durable-object", worker: "core", exportName: "CategoryProbe" },
    DIRECTORY: { type: "durable-object", worker: "registry", exportName: "Directory" },
    PRICING: { type: "durable-object", worker: "registry", exportName: "Pricing" },
    ERASURE: { type: "durable-object", worker: "registry", exportName: "Erasure" },
    MAINTENANCE: { type: "durable-object", worker: "registry", exportName: "Maintenance" },
  } as const;

  const runtime = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          unsafeInspectDurableObjects: true,
          resourcePersistencePath: input.path,
          workers: [
            {
              config: {
                type: "worker",
                name: "core",
                compatibilityDate: "2026-09-08",
                manifest: owner,
                exports: { CategoryProbe: { type: "durable-object", storage: "sqlite" } },
                env: bindings,
              },
            },
            {
              config: {
                type: "worker",
                name: "registry",
                compatibilityDate: "2026-09-08",
                compatibilityFlags: ["nodejs_compat"],
                manifest: registry,
                exports: {
                  Directory: { type: "durable-object", storage: "sqlite" },
                  Pricing: { type: "durable-object", storage: "sqlite" },
                  Erasure: { type: "durable-object", storage: "sqlite" },
                  Maintenance: { type: "durable-object", storage: "sqlite" },
                },
                env: bindings,
              },
            },
            {
              config: {
                type: "worker",
                name: "overlap-reader",
                compatibilityDate: "2026-09-08",
                manifest: reader,
              },
            },
          ],
        })
    ),
    (runtime) => native(() => runtime.dispose())
  );

  const store = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const observer = yield* native(() => runtime.getWorker("overlap-reader"));

  const capture = (
    user: string,
    id: string,
    caller: Option.Option<string>
  ): Effect.Effect<Pick<Response, "json" | "status">> =>
    native(() =>
      store.getByName(user).fetch("https://probe.invalid/fixture/capture", {
        method: "POST",
        body: JSON.stringify({ user, id, caller: Option.getOrNull(caller) }),
      })
    );

  const local = (
    user: string
  ): Effect.Effect<Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>> =>
    native(() => runtime.unsafeGetDurableObjectStorage("core", "CategoryProbe", { name: user }));

  const interpret = (
    reference: CategoryReference
  ): Effect.Effect<Pick<Response, "json" | "status">> =>
    native(() =>
      observer.fetch("https://observer.invalid/read", {
        method: "POST",
        body: JSON.stringify(reference),
      })
    );

  const history = (): Effect.Effect<Pick<Response, "json" | "status">> =>
    native(() =>
      store.getByName(alice).fetch("https://api.fidyapp.com/transactions", {
        headers: { cookie: "__Host-fidy_session=" + bearer, "Fidy-Session-Binding": session },
      })
    );

  const link = (): Effect.Effect<Pick<Response, "json" | "status">> =>
    native(() =>
      store.getByName(alice).fetch("https://api.fidyapp.com/transactions/link", {
        method: "POST",
        headers: {
          cookie: "__Host-fidy_session=" + bearer,
          "Fidy-Session-Binding": session,
          "content-type": "application/json",
        },
        body: JSON.stringify({ firstTransactionId: first, secondTransactionId: second }),
      })
    );

  return { capture, local, interpret, observer, history, link };
});

const categorizeUnderOriginalRelease = Effect.fn(function* (path: string) {
  const runtime = yield* start({ path, owner: currentCategoryRelease, reader: prepared });

  yield* Effect.forEach(
    [alice, bob],
    Effect.fnUntraced(function* (user) {
      const local = yield* runtime.local(user);
      yield* native(() =>
        local.exec(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',1)",
          user
        )
      );
      yield* native(() =>
        local.exec("INSERT INTO categories VALUES (?,'Mercado',2)", categoryIds.mercado)
      );
    }),
    { discard: true }
  );

  const local = yield* runtime.local(alice);
  const now = yield* Clock.currentTimeMillis;

  const digest = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
  );

  yield* native(() =>
    local.exec(
      "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
      session,
      first,
      alice,
      digest,
      now,
      now + 600000,
      now + 3600000,
      now + 7776000000
    )
  );
  yield* native(() =>
    local.exec(
      "INSERT INTO keyword_rules(id,user_id,keyword,category_id,category_revision,created_at_ms,updated_at_ms) VALUES (?,?, 'mercado',?,'co-1',1,1)",
      first,
      alice,
      categoryIds.mercado
    )
  );
  const matched = yield* runtime.capture(alice, first, Option.none());
  expect(matched.status).toBe(200);
  expect(yield* native(() => matched.json())).toEqual({
    categoryId: categoryIds.mercado,
    revision: "co-1",
  });
  const unmatched = yield* runtime.capture(bob, first, Option.none());
  expect(yield* native(() => unmatched.json())).toEqual({
    categoryId: categoryIds.otros,
    revision: "co-1",
  });
  yield* native(() =>
    local.exec(
      "INSERT INTO budgets(id,user_id,category_id,category_revision,currency,cap,created_at_ms,updated_at_ms) VALUES (?,?,?,'co-1','COP','1000',1,1)",
      first,
      alice,
      categoryIds.mercado
    )
  );
  yield* native(() =>
    local.exec(
      "INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms,before_category_revision,after_category_revision) VALUES (?,?,?,0,'[\"categoryId\"]',?,?,1,'co-1','co-1')",
      first,
      alice,
      first,
      JSON.stringify({ categoryId: categoryIds.otros }),
      JSON.stringify({ categoryId: categoryIds.mercado })
    )
  );
  const denied = yield* runtime.capture(alice, second, Option.some(added));
  expect(denied.status).toBe(409);
  expect(compatibleCategoryReleases({ serving: currentCategoryRelease, candidate: writing })).toBe(
    false
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "categorizes locally and preserves retained choices across overlapping reader-first releases",
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-taxonomy-" });
      yield* Effect.scoped(categorizeUnderOriginalRelease(path));
      const runtime = yield* start({ path, owner: writing, reader: prepared });

      const published = yield* native(() =>
        runtime.observer.fetch("https://observer.invalid/release")
      );

      const advertised = yield* native(() => published.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CategoryTaxonomyRelease))
      );

      expect(compatibleCategoryReleases({ serving: advertised, candidate: writing })).toBe(true);
      const captured = yield* runtime.capture(alice, second, Option.some(added));
      expect(captured.status).toBe(200);

      const reference = yield* native(() => captured.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CategoryReference))
      );

      const read = yield* runtime.interpret(reference);
      expect(yield* native(() => read.json())).toEqual({ id: added, label: "Prueba" });
      const fresh = yield* runtime.history();
      expect(fresh.status).toBe(200);
      expect(yield* native(() => fresh.json())).toMatchObject({
        data: [
          { id: second, categoryId: added },
          { id: first, categoryId: categoryIds.mercado },
        ],
      });
      const local = yield* runtime.local(alice);
      yield* native(() =>
        local.exec(
          "UPDATE transactions SET user_decisions=? WHERE id=?",
          JSON.stringify({ categoryId: true }),
          second
        )
      );
      const linked = yield* runtime.link();
      expect(linked.status).toBe(200);
      expect(yield* native(() => linked.json())).toMatchObject({
        data: { id: first, categoryId: added },
      });
      const effective = yield* runtime.history();
      expect(yield* native(() => effective.json())).toMatchObject({
        data: [{ id: first, categoryId: added }],
      });
      expect(
        yield* native(() =>
          local.exec(
            "UPDATE transaction_projection_leaf SET category_revision='co-9' WHERE user_id=? AND id=? RETURNING id",
            alice,
            first
          )
        )
      ).toEqual([{ id: first }]);
      expect((yield* runtime.history()).status).toBe(503);
      yield* native(() =>
        local.exec(
          "UPDATE transaction_projection_state SET readiness='rebuilding' WHERE user_id=?",
          alice
        )
      );
      yield* native(() =>
        local.exec("UPDATE transactions SET category_revision='co-9' WHERE id=?", second)
      );
      expect((yield* runtime.history()).status).toBe(503);

      const history = yield* native(() =>
        local.exec(
          "SELECT category_id AS categoryId,category_revision AS revision FROM transactions WHERE id=? UNION ALL SELECT category_id,category_revision FROM keyword_rules WHERE user_id=? UNION ALL SELECT category_id,category_revision FROM budgets WHERE user_id=? UNION ALL SELECT json_extract(after_facts,'$.categoryId'),after_category_revision FROM transaction_corrections WHERE user_id=?",
          first,
          alice,
          alice,
          alice
        )
      );

      expect(history).toHaveLength(4);

      yield* Effect.forEach(
        history,
        Effect.fnUntraced(function* (stored) {
          const ref = yield* Schema.decodeUnknownEffect(CategoryReference)(stored);
          const result = yield* runtime.interpret(ref);
          expect(yield* native(() => result.json())).toEqual({
            id: categoryIds.mercado,
            label: "Mercado",
          });
        }),
        { discard: true }
      );
    })
  );
});
