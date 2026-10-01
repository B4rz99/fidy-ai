import { recordAuthorizedCall } from "~/shell/audit/operations";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";

type BrowserCategorySubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

/** Count browser Category work only for its live User-owned WebSession. */
export const recordBrowserCategoryWork = ({
  subject,
  id,
  current,
}: Readonly<{ subject: BrowserCategorySubject; id: string; current: number }>): OwnedStatement => {
  const authority = liveWebSessionAuthority({ subject, current });
  return recordAuthorizedCall({
    authority,
    id,
    operation: "categories.listCategories",
    outcome: "success",
    current,
    afterOwnerWrite: false,
  });
};
