import { NodeFileSystem } from "@effect/platform-node";
import { Miniflare } from "miniflare";
import { afterEach } from "vitest";
import { expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Option } from "effect";
import { CategoryId } from "../../src/core/categories/contract";
import {
  categoryExistenceGuard,
  checkCategories,
  listCategoryProjection,
  prepareCategorization,
  requireCategory,
} from "./operations";

const instances: Array<Miniflare> = [];
const userId = "20000000-0000-4000-8000-000000000001";
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });
const setup = Effect.gen(function* () {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "category-operations",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "category-operations", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch(){return new Response('ok')}}",
                type: "esm",
              },
            },
          },
        },
      },
    ],
  });
  instances.push(mf);
  yield* attempt(() => mf.ready);
  const db = yield* attempt(() => mf.getD1Database("DB"));
  const fs = yield* FileSystem.FileSystem;
  const migration = yield* fs.readFileString(
    new URL("../migrations/0001_categories.sql", import.meta.url).pathname
  );
  for (const statement of migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)) {
    yield* attempt(() => db.prepare(statement).run());
  }
  yield* attempt(() =>
    db
      .prepare(`CREATE TABLE keyword_rules (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, keyword TEXT NOT NULL,
    normalized_keyword TEXT NOT NULL, category_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
      .run()
  );
  return db;
});
afterEach(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())).then(() => undefined));

it.layer(NodeFileSystem.layer)((it) => {
  it.effect("requires a stable Category and distinguishes absence from unreadable data", () =>
    Effect.gen(function* () {
      const db = yield* setup;
      const known = yield* requireCategory({
        db,
        userId,
        categoryId: "10000000-0000-4000-8000-000000000003",
      });
      expect(known).toEqual({ id: "10000000-0000-4000-8000-000000000003", label: "Mercado" });
      const absent = yield* Effect.result(
        requireCategory({ db, userId, categoryId: "90000000-0000-4000-8000-000000000009" })
      );
      expect(absent).toMatchObject({ _tag: "Failure", failure: { _tag: "CategoryNotFound" } });
      yield* attempt(() => db.prepare("DROP TABLE categories").run());
      const unreadable = yield* Effect.result(
        requireCategory({ db, userId, categoryId: known.id })
      );
      expect(unreadable).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CategoryDataUnavailable" },
      });
    })
  );

  it.effect("keeps commit-time Category existence inside the caller's atomic write", () =>
    Effect.gen(function* () {
      const db = yield* setup;
      yield* attempt(() => db.prepare("CREATE TABLE owner_writes (id TEXT PRIMARY KEY)").run());
      const categoryId = "10000000-0000-4000-8000-000000000003";
      const condition = categoryExistenceGuard(categoryId);
      // Existence observed before a write cannot authorize a Category removed before commit.
      yield* requireCategory({ db, userId, categoryId });
      yield* attempt(() =>
        db.prepare("DELETE FROM categories WHERE id = ?").bind(categoryId).run()
      );
      const write = yield* attempt(() =>
        db
          .prepare(`INSERT INTO owner_writes (id) SELECT ? WHERE ${condition.sql}`)
          .bind("attempted", ...condition.params)
          .run()
      );
      expect(write.meta.changes).toBe(0);
      expect(
        (yield* attempt(() => db.prepare("SELECT id FROM owner_writes").all())).results
      ).toEqual([]);
    })
  );

  it.effect(
    "refuses an oversized User rule projection instead of categorizing from a truncated policy",
    () =>
      Effect.gen(function* () {
        const db = yield* setup;
        yield* attempt(() =>
          db
            .prepare(`WITH RECURSIVE numbers(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 101
  ) INSERT INTO keyword_rules SELECT '70000000-0000-4000-8000-' || printf('%012d', n), ?,
    'rule-' || n, 'rule-' || n, '10000000-0000-4000-8000-000000000003',
    '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z' FROM numbers`)
            .bind(userId)
            .run()
        );
        expect(yield* Effect.result(prepareCategorization({ db, userId }))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "CategoryDataUnavailable" },
        });
      })
  );

  it.effect(
    "projects stable Category identities in presentation order and refuses malformed metadata",
    () =>
      Effect.gen(function* () {
        const db = yield* setup;
        yield* attempt(() =>
          db.prepare("UPDATE categories SET display_order = display_order + 100").run()
        );
        yield* attempt(() =>
          db
            .prepare(
              "UPDATE categories SET label = 'Mercado actualizado', display_order = 0 WHERE id = ?"
            )
            .bind("10000000-0000-4000-8000-000000000003")
            .run()
        );
        const choices = Option.getOrThrow(yield* listCategoryProjection({ db, userId }));
        expect(
          Option.getOrThrow(
            yield* checkCategories({
              db,
              userId,
              categoryIds: [
                "10000000-0000-4000-8000-000000000003",
                "10000000-0000-4000-8000-000000000003",
              ],
            })
          )
        ).toBe(true);
        expect(
          Option.getOrThrow(
            yield* checkCategories({
              db,
              userId,
              categoryIds: ["90000000-0000-4000-8000-000000000009"],
            })
          )
        ).toBe(false);
        expect(choices[0]).toEqual({
          id: "10000000-0000-4000-8000-000000000003",
          label: "Mercado actualizado",
        });
        expect(choices.at(-1)).toEqual({
          id: "10000000-0000-4000-8000-000000000016",
          label: "Otros",
        });
        yield* attempt(() =>
          db.prepare("UPDATE categories SET label = '' WHERE id = ?").bind(choices[0]?.id).run()
        );
        expect(Option.isNone(yield* listCategoryProjection({ db, userId }))).toBe(true);
        yield* attempt(() => db.prepare("DROP TABLE categories").run());
        expect(
          Option.isNone(
            yield* checkCategories({
              db,
              userId,
              categoryIds: ["10000000-0000-4000-8000-000000000003"],
            })
          )
        ).toBe(true);
      })
  );

  it.effect(
    "categorizes future capture from one User's bounded snapshot without exposing another User's rules",
    () =>
      Effect.gen(function* () {
        const db = yield* setup;
        const userB = "20000000-0000-4000-8000-000000000002";
        yield* attempt(() =>
          db
            .prepare(`INSERT INTO keyword_rules VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, 'Rappi', 'rappi',
      '10000000-0000-4000-8000-000000000002', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`)
            .bind(userId)
            .run()
        );
        const classifyA = yield* prepareCategorization({ db, userId });
        const classifyB = yield* prepareCategorization({ db, userId: userB });
        const input = {
          counterparty: Option.some("RÁPPI Bogotá"),
          caller: Option.none<CategoryId>(),
          direction: "outflow" as const,
        };
        expect(yield* classifyA(input)).toBe("10000000-0000-4000-8000-000000000002");
        expect(yield* classifyB(input)).toBe("10000000-0000-4000-8000-000000000016");
        expect(
          yield* classifyA({
            ...input,
            caller: Option.some(CategoryId.make("10000000-0000-4000-8000-000000000003")),
          })
        ).toBe("10000000-0000-4000-8000-000000000003");
        yield* attempt(() =>
          db.prepare("DELETE FROM keyword_rules WHERE user_id = ?").bind(userId).run()
        );
        // An admitted chunk keeps its snapshot; the next capture observes the rule change.
        expect(yield* classifyA(input)).toBe("10000000-0000-4000-8000-000000000002");
        const next = yield* prepareCategorization({ db, userId });
        expect(yield* next(input)).toBe("10000000-0000-4000-8000-000000000016");
        expect(yield* next({ ...input, direction: "inflow" })).toBe(
          "10000000-0000-4000-8000-000000000015"
        );
      })
  );
});
