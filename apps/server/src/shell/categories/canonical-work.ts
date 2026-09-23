import { Option, Schema } from "effect";
import { Category } from "~/core/categories/model";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";
import type { ListCategoriesResponse } from "./operations";
import { maximumCategoryCount } from "./list-categories";

/** Execute the bounded Category projection only while its caller remains authoritative in D1. */
export const protectedCategoryRows = (
  authority: Readonly<{
    table: "pats" | "web_sessions";
    predicate: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }>
): OwnedStatement => ({
  sql: `SELECT id,label FROM categories WHERE EXISTS (
    SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ORDER BY display_order LIMIT ${maximumCategoryCount + 1}`,
  params: authority.bindings,
});

/** Interpret D1 rows through the same Category contract as the hosted query. */
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

/** Count browser Category work only for its live User-owned WebSession. */
export const recordBrowserCategoryWork = (
  subject: Readonly<{ id: string; userId: string; digest: Uint8Array }>,
  id: string,
  current: number
): OwnedStatement => {
  const authority = liveWebSessionAuthority(subject, current);
  return {
    sql: `INSERT INTO category_audit (id,user_id,session_id,operation,occurred_at_ms)
      SELECT ?,user_id,id,'categories.listCategories',? FROM web_sessions WHERE ${authority.predicate}`,
    params: [id, current, ...authority.bindings],
  };
};
