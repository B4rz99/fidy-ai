import { Option, Schema } from "effect";
import { Category } from "~/core/categories/model";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { ListCategoriesResponse } from "./operations";

const maximumCategoryCount = 100;

type Authority = Readonly<{
  table: "pats" | "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** One Category projection for hosted-agent and D1-protected HTTP reads. */
export const categoryRowsQuery = (authority?: Authority): OwnedStatement => ({
  sql: `SELECT id,label FROM categories
    ${authority === undefined ? "" : `WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`}
    ORDER BY display_order LIMIT ${maximumCategoryCount + 1}`,
  params: authority?.bindings ?? [],
});

/** Apply the same bounded Category response codec in both execution adapters. */
export const categoryResponseFromRows = (
  rows: unknown
): Option.Option<typeof ListCategoriesResponse.Type> => {
  const categories = Schema.decodeUnknownOption(Schema.Array(Category))(rows);
  return Option.flatMap(categories, (decoded) =>
    decoded.length <= maximumCategoryCount
      ? Option.some({ data: decoded, next: [] as const })
      : Option.none()
  );
};
