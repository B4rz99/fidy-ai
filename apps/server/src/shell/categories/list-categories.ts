import { Data, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Unavailable } from "~/shell/public-http/contract";
import type { ListCategoriesResponse } from "./operations";
import { categoryResponseFromRows, categoryRowsQuery } from "./query";

/** Safe reason returned when authoritative Category data cannot be loaded. */
export class CategoryQueryFailure extends Data.TaggedError("CategoryQueryFailure")<{
  readonly reason: "unavailable";
}> {}

const queryFailure = (): CategoryQueryFailure =>
  new CategoryQueryFailure({ reason: "unavailable" });

const loadCategories: Effect.Effect<
  typeof ListCategoriesResponse.Type,
  CategoryQueryFailure,
  SqlClient.SqlClient
> = Effect.flatMap(SqlClient.SqlClient, (sql) => {
  const query = categoryRowsQuery();
  return sql.unsafe<Record<string, unknown>>(query.sql, query.params);
}).pipe(
  Effect.mapError(queryFailure),
  Effect.flatMap((rows) => Effect.fromOption(categoryResponseFromRows(rows), queryFailure))
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
> = loadCategories.pipe(Effect.mapError(categoryUnavailable));
