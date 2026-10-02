import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";
import { decodeCategoryRead, prepareCategoryRead } from "../../../src/shell/categories/operations";
import { Effect, Option, Schema } from "effect";
import { Category, CategoryNotFound } from "../../../src/core/categories/contract";
import type { CategoryId } from "../../../src/core/categories/reference";
import { CategoriesUnavailable } from "../contract";

/** Load one required current projection; absence remains distinct from invalid or unreadable storage. */
export const requiredCategory = ({
  db,
  categoryId,
}: Readonly<{ db: D1Database; categoryId: CategoryId }>): Effect.Effect<
  Category,
  CategoryNotFound | CategoriesUnavailable
> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        db.prepare("SELECT id, label FROM categories WHERE id = ?").bind(categoryId).first(),
      catch: () => new CategoriesUnavailable(),
    });
    if (row === null) return yield* new CategoryNotFound({ categoryId });
    return yield* Schema.decodeUnknownEffect(Category)(row).pipe(
      Effect.mapError(() => new CategoriesUnavailable())
    );
  });

/** Every retained Category is decoded; corrupt overflow cannot masquerade as a complete taxonomy. */
export const categoryList = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<ReadonlyArray<Category>, CategoriesUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => prepareCategoryRead({ db, authority: Option.none() }).all(),
      catch: () => new CategoriesUnavailable(),
    });
    return yield* Effect.fromOption(
      Option.map(decodeCategoryRead(result.results), (response) => response.data),
      () => new CategoriesUnavailable()
    );
  });

/** The named public relation contains at most the exact requested Category identity. */
export const categoryReferenceStatement = ({
  db,
  categoryId,
  statement,
}: Readonly<{
  db: D1Database;
  categoryId: CategoryId;
  statement: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`WITH category_reference AS (SELECT id FROM categories WHERE id = ? LIMIT 1)
${statement.sql}`)
    .bind(categoryId, ...statement.params);

/** Check the owned storage schema without reading Category or User content. */
export const verifyStorage = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<void, CategoriesUnavailable> =>
  Effect.tryPromise({
    try: () => db.prepare("SELECT id FROM categories LIMIT 0").all(),
    catch: () => new CategoriesUnavailable(),
  }).pipe(Effect.asVoid);
