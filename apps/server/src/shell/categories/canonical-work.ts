import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";

type BrowserCategorySubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

/** Count browser Category work only for its live User-owned WebSession. */
export const recordBrowserCategoryWork = ({
  subject,
  id,
  current,
}: Readonly<{ subject: BrowserCategorySubject; id: string; current: number }>): OwnedStatement => {
  const authority = liveWebSessionAuthority(subject, current);
  return {
    sql: `INSERT INTO category_audit (id,user_id,session_id,operation,occurred_at_ms)
      SELECT ?,user_id,id,'categories.listCategories',? FROM web_sessions WHERE ${authority.predicate}`,
    params: [id, current, ...authority.bindings],
  };
};
