import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { CategoryNotFound, CategoryReference } from "../../../src/core/categories/contract";
import {
  activeCategoryTaxonomy,
  categorizeCapture,
  currentCategoryRelease,
  interpretCategory,
} from "../../../src/core/categories/operations";
import type { UserId } from "../../../src/core/identity/contract";
import { type CaptureCategoryInput, CategoriesUnavailable } from "../contract";
import { keywordRulesFromRows, keywordRulesQuery } from "./keyword-rules";

export const resolveLocalCategory = Effect.fn(function* ({
  userId,
  capture,
}: Readonly<{
  userId: UserId;
  capture: CaptureCategoryInput;
}>) {
  const sql = yield* SqliteClient;
  const release = currentCategoryRelease;
  const revision = activeCategoryTaxonomy(release).id;
  const query = keywordRulesQuery({ userId });

  const [owner] =
    yield* sql`SELECT id FROM users WHERE id=${userId} AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${userId})`;

  if (owner === undefined) return yield* new CategoriesUnavailable();

  const rows = Option.isSome(capture.counterparty)
    ? yield* sql.unsafe(
        `SELECT selected.*,rule.category_revision AS revision
        FROM (${query.sql}) selected JOIN keyword_rules rule ON rule.id=selected.id AND rule.user_id=?`,
        [...query.params, userId]
      )
    : [];

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row) {
      const stored = yield* Schema.decodeUnknownEffect(CategoryReference)(row);

      if (Option.isNone(interpretCategory({ release, reference: stored }))) {
        return yield* new CategoriesUnavailable();
      }
    }),
    { discard: true }
  );

  const rules = keywordRulesFromRows(rows);

  if (Option.isNone(rules)) return yield* new CategoriesUnavailable();
  const categoryId = yield* categorizeCapture({ ...capture, rules: rules.value });
  const reference: CategoryReference = { revision, categoryId };
  const category = interpretCategory({ release, reference });

  if (Option.isNone(category)) {
    return yield* Option.match(capture.caller, {
      onSome: () => new CategoryNotFound({ categoryId }),
      onNone: () => new CategoriesUnavailable(),
    });
  }

  return reference;
});

export const retainLocalCategory = Effect.fn(function* (reference: CategoryReference) {
  const sql = yield* SqliteClient;
  const category = interpretCategory({ release: currentCategoryRelease, reference });

  if (Option.isNone(category)) return yield* new CategoriesUnavailable();
  const { categoryId } = reference;
  yield* sql`INSERT INTO categories(id,label,display_order)
    SELECT ${categoryId},${category.value.label},COALESCE((SELECT MAX(display_order)+1 FROM categories),0)
    WHERE NOT EXISTS(SELECT 1 FROM categories WHERE id=${categoryId})`;

  return reference;
});

export const categorizeLocalCapture = Effect.fnUntraced(function* (
  input: Parameters<typeof resolveLocalCategory>[0]
) {
  return yield* resolveLocalCategory(input).pipe(Effect.tap(retainLocalCategory));
});
