import type { OwnedStatement } from "~/shell/owner-write/contract";

export const activeProGrantSelection = (users: OwnedStatement): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM pro_grant_events g WHERE g.user_id IN (${users.sql})
    AND g.action = 'grant' AND g.sequence =
      (SELECT MAX(latest.sequence) FROM pro_grant_events latest WHERE latest.user_id = g.user_id))`,
  params: users.params,
});
