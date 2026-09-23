import { Data, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Category } from "~/core/categories/model";
import { Unavailable } from "~/shell/public-http/contract";
import type { ListCategoriesResponse } from "./operations";

export const maximumCategoryCount = 100;
const categoryQueryLimit = maximumCategoryCount + 1;

/** Safe reason returned when authoritative Category data cannot be loaded. */
export class CategoryQueryFailure extends Data.TaggedError("CategoryQueryFailure")<{
  readonly reason: "unavailable";
}> {}

const queryFailure = (): CategoryQueryFailure =>
  new CategoryQueryFailure({ reason: "unavailable" });

const loadCategoryRows: Effect.Effect<
  ReadonlyArray<Category>,
  CategoryQueryFailure,
  SqlClient.SqlClient
> = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: Category,
    execute: () =>
      sql`SELECT id, label FROM categories ORDER BY display_order LIMIT ${categoryQueryLimit}`,
  })(undefined)
).pipe(
  Effect.mapError(queryFailure),
  Effect.filterOrFail((categories) => categories.length <= maximumCategoryCount, queryFailure)
);

export const categoryUnavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "Categories are temporarily unavailable. Retry later.",
    },
    next: [],
  });

/** Canonical Categories query shared by HTTP and hosted-agent execution. */
export const listCategoriesResponse: Effect.Effect<
  typeof ListCategoriesResponse.Type,
  Unavailable,
  SqlClient.SqlClient
> = loadCategoryRows.pipe(
  Effect.map((categories) => ({ data: categories, next: [] })),
  Effect.mapError(categoryUnavailable)
);
