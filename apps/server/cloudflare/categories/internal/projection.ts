import { listLaunchCategories } from "../../../src/core/categories/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { decodeCategoryRead, prepareCategoryRead } from "../../../src/shell/categories/operations";
import { Effect, Option } from "effect";
import {
  type Category,
  type CategoryId,
  CategoryNotFound,
} from "../../../src/core/categories/contract";

import { CategoriesUnavailable } from "../contract";
import type { QueryAuthority } from "../../canonical-work/operations";

export const prepareCategorySnapshot = ({
  db,
  authority,
}: Readonly<{ db: D1Database; authority: QueryAuthority }>): Readonly<{
  statement: D1PreparedStatement;
  decode: (rows: unknown) => Option.Option<ReadonlyArray<Category>>;
}> => ({
  statement: prepareCategoryRead({ db, authority: Option.some(authority) }),
  decode: (rows) => Option.map(decodeCategoryRead(rows), (response) => response.data),
});

export const requiredCategory = ({
  categoryId,
}: Readonly<{ db: D1Database; categoryId: CategoryId }>): Effect.Effect<
  Category,
  CategoryNotFound | CategoriesUnavailable
> =>
  Effect.gen(function* () {
    const category = listLaunchCategories().find((value) => value.id === categoryId);
    if (category === undefined) return yield* new CategoryNotFound({ categoryId });
    return category;
  });

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
    .prepare(`WITH category_reference AS (SELECT id FROM categories WHERE id = ? AND ? LIMIT 1)
${statement.sql}`)
    .bind(
      categoryId,
      Number(listLaunchCategories().some((value) => value.id === categoryId)),
      ...statement.params
    );

export const verifyStorage = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<void, CategoriesUnavailable> =>
  Effect.tryPromise({
    try: () => db.prepare("SELECT id FROM categories LIMIT 0").all(),
    catch: () => new CategoriesUnavailable(),
  }).pipe(Effect.asVoid);
