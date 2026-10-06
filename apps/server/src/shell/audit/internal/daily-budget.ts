import { Schema } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";

import { dailyAuditBudget, utcDayMilliseconds } from "~/shell/audit/contract";

const DailyAuditTotal = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/**
 * The canonical AuditLogEntry rows one User's UTC day counts. Batch-envelope refusals are
 * excluded; each audit trigger counts the same seven-table union.
 */
export const auditDayCountExpression = `(SELECT count(*) FROM transaction_audit WHERE user_id = ?
      AND operation != 'operations.executeAtomicBatch' AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM pat_audit WHERE user_id = ?
      AND operation != 'operations.executeAtomicBatch'
      AND (((pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL))
        AND operation NOT LIKE 'pats.%') OR operation IN ('pats.listPATs', 'recurring.listRecurringSeries'))
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM category_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM memory_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM statement_submission_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM statement_review_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM statement_clarification_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)`;

/** Parameters for the seven-table UTC-day count; callers use this with `auditDayCountExpression` in D1. */
export const auditDayBindings = ({
  userId,
  current,
}: Readonly<{ userId: string; current: number }>): ReadonlyArray<string | number> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return Array.from({ length: 7 }).flatMap(() => [userId, start, start + utcDayMilliseconds]);
};

/** How many canonical audit rows one User has committed in the UTC day containing `current`. */
export const dailyAuditCount = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<number> =>
  db
    .prepare(`SELECT ${auditDayCountExpression} AS total`)
    .bind(...auditDayBindings({ userId, current }))
    .first<unknown>()
    .then((row) => Schema.decodeUnknownSync(DailyAuditTotal)(row).total);

/** Enforces the separate browser Budget/Insight budget under the indexed canonical child guard. */
export const browserBudgetGuard = ({
  owner,
  userId,
  current,
  index,
  operation,
}: Readonly<{
  owner: "budgets" | "insights";
  userId: string;
  current: number;
  index: number;
  operation: string;
}>): OwnedStatement => {
  const table = owner === "budgets" ? "budget_audit" : "insight_audit";
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return {
    sql: `INSERT INTO canonical_child_guard (child_index,operation,accepted,budget_ok)
      SELECT ?,?,1,CASE WHEN (SELECT count(*) FROM ${table} WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?) < ? THEN 1 ELSE 0 END
      ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation, accepted = excluded.accepted, budget_ok = excluded.budget_ok`,
    params: [index, operation, userId, start, start + utcDayMilliseconds, dailyAuditBudget],
  };
};

/** True while the User's shared daily canonical-work budget is already spent. */
export const dailyAuditExhausted = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<boolean> =>
  dailyAuditCount({ db, userId, current }).then((count) => count >= dailyAuditBudget);
