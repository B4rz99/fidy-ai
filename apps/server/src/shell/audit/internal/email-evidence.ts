import type { OwnedStatement } from "~/shell/owner-write/contract";

import type { EmailReplacementEvidence } from "~/shell/audit/contract";

/** Append one credential owner's replacement outcome, optionally chained to its preceding transition. */
export const emailReplacementEvidence = (input: EmailReplacementEvidence): OwnedStatement => ({
  sql: `INSERT INTO email_replacement_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT ?, ?, ?, ?, ?, ? ${input.afterOwnerWrite ? "WHERE changes() = 1" : ""}`,
  params: [input.id, input.userId, input.sessionId, input.operation, input.outcome, input.current],
});
