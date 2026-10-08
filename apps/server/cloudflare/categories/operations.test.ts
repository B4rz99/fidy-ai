import { deepStrictEqual } from "node:assert";
import { Effect, Exit, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { CategoryId, CategoryNotFound } from "../../src/core/categories/contract";

import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  categorizeCaptures,
  listCategories,
  prepareCategoryReference,
  requireCategory,
} from "./operations";
import { CategoriesUnavailable } from "./contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const setup = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: [new URL("../migrations/0001_categories.sql", import.meta.url)],
    }).then(() => db)
  );

it("requires a stable Category while keeping its current label independent of identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE categories SET label = 'Comidas', display_order = 50 WHERE id = ?")
          .bind(categoryId)
          .run()
      );
      expect(yield* requireCategory({ db, categoryId })).toEqual({
        id: categoryId,
        label: "Comidas",
      });
      const missing = CategoryId.make("90000000-0000-4000-8000-000000000001");
      deepStrictEqual(
        yield* Effect.exit(requireCategory({ db, categoryId: missing })),
        Exit.fail(new CategoryNotFound({ categoryId: missing }))
      );
    })
  ));

it("returns only bounded current Category projections in presentation order and fails closed on overflow", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const categories = yield* listCategories({ db });
      expect(categories.map((category) => category.label)).toEqual([
        "Restaurantes",
        "Domicilios",
        "Mercado",
        "Transporte",
        "Vivienda",
        "Servicios",
        "Salud",
        "Educación",
        "Compras",
        "Entretenimiento",
        "Viajes",
        "Impuestos",
        "Transferencias",
        "Retiros de efectivo",
        "Ingresos",
        "Otros",
      ]);
      yield* Effect.tryPromise(() =>
        db.batch(
          Array.from({ length: 85 }, (_, index) =>
            db
              .prepare("INSERT INTO categories (id, label, display_order) VALUES (?, 'Extra', ?)")
              .bind(`90000000-0000-4000-8000-${String(index).padStart(12, "0")}`, index + 100)
          )
        )
      );
      deepStrictEqual(
        yield* Effect.exit(listCategories({ db })),
        Exit.fail(new CategoriesUnavailable())
      );
    })
  ));

const setupRules = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: [
        "0001_categories",
        "0002_resource_admission",
        "0003_pending_consent",
        "0005_verified_onboarding",
        "0006_browser_login",
        "0007_browser_pairing_email",
        "0008_support_recovery",
        "0009_email_replacement",
        "0009_transactions",
        "0010_pat_lifecycle",
        "0011_transaction_corrections",
        "0012_statement_staging",
        "0012_transaction_search",
        "0013_category_keyword_rules",
      ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
    }).then(() => db)
  );

it("categorizes each User's captures without exposing or borrowing another User's keyword instructions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setupRules);
      const userA = "10000000-0000-4000-8000-000000000001";
      const userB = "20000000-0000-4000-8000-000000000002";
      const mercado = CategoryId.make("10000000-0000-4000-8000-000000000003");
      yield* Effect.tryPromise(() =>
        db.batch([
          ...[userA, userB].map((userId) =>
            db
              .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)")
              .bind(userId)
          ),
          db
            .prepare(
              "INSERT INTO keyword_rules VALUES ('30000000-0000-4000-8000-000000000003', ?, 'Éxito', 'exito', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')"
            )
            .bind(userA, mercado),
        ])
      );
      const captures = [
        {
          caller: Option.none<CategoryId>(),
          counterparty: Option.some("ÉXITO Bogotá"),
          direction: "outflow" as const,
        },
        {
          caller: Option.none<CategoryId>(),
          counterparty: Option.none<string>(),
          direction: "inflow" as const,
        },
      ];
      expect(yield* categorizeCaptures({ db, userId: userA, captures })).toEqual([
        mercado,
        "10000000-0000-4000-8000-000000000015",
      ]);
      expect(yield* categorizeCaptures({ db, userId: userB, captures })).toEqual([
        "10000000-0000-4000-8000-000000000016",
        "10000000-0000-4000-8000-000000000015",
      ]);
      deepStrictEqual(
        yield* Effect.exit(
          categorizeCaptures({
            db,
            userId: userA,
            captures: Array.from({ length: 101 }, () => ({
              caller: Option.none<CategoryId>(),
              counterparty: Option.some("ÉXITO Bogotá"),
              direction: "outflow" as const,
            })),
          })
        ),
        Exit.fail(new CategoriesUnavailable())
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE keyword_rules SET keyword = '' WHERE user_id = ?").bind(userA).run()
      );
      deepStrictEqual(
        yield* Effect.exit(categorizeCaptures({ db, userId: userA, captures })),
        Exit.fail(new CategoriesUnavailable())
      );
      expect(yield* categorizeCaptures({ db, userId: userB, captures })).toEqual([
        "10000000-0000-4000-8000-000000000016",
        "10000000-0000-4000-8000-000000000015",
      ]);
    })
  ));

it("distinguishes malformed Category storage from absence without leaking rows or database failures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE categories SET label = '' WHERE id = ?").bind(categoryId).run()
      );
      deepStrictEqual(
        yield* Effect.exit(requireCategory({ db, categoryId })),
        Exit.fail(new CategoriesUnavailable())
      );
      deepStrictEqual(
        yield* Effect.exit(listCategories({ db })),
        Exit.fail(new CategoriesUnavailable())
      );
      yield* Effect.tryPromise(() => db.prepare("DROP TABLE categories").run());
      deepStrictEqual(
        yield* Effect.exit(requireCategory({ db, categoryId })),
        Exit.fail(new CategoriesUnavailable())
      );
    })
  ));

it("rechecks a required Category inside the caller's native atomic unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
      yield* Effect.tryPromise(() =>
        db.prepare("CREATE TABLE category_selections (id TEXT NOT NULL)").run()
      );
      const statement = prepareCategoryReference({
        db,
        categoryId,
        statement: {
          sql: "INSERT INTO category_selections SELECT id FROM category_reference",
          params: [],
        },
      });
      yield* Effect.tryPromise(() =>
        db.batch([db.prepare("DELETE FROM categories WHERE id = ?").bind(categoryId), statement])
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM category_selections").all()))
          .results
      ).toEqual([]);
    })
  ));
