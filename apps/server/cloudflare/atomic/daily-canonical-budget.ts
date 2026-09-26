const utcDayMilliseconds = 86_400_000;

/** Matches the 256-entry stable-User triggers in 0015_statement_submission.sql; the triggers stay the authority. */
export const dailyAuditBudget = 256;

/**
 * The canonical AuditLogEntry rows one User's UTC day counts: transaction, PAT, category, Memory,
 * statement submission. Every audit table's own trigger counts this same union, so this read and
 * the trigger that refuses an insert can never disagree about what the budget covers.
 */
const auditDayRows = `SELECT occurred_at_ms FROM transaction_audit WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM pat_audit WHERE user_id = ?
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM category_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM memory_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM statement_submission_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?`;

/** How many canonical audit rows one User has committed in the UTC day containing `current`. */
export const dailyAuditCount = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<number> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return db
    .prepare(`SELECT count(*) AS total FROM (${auditDayRows})`)
    .bind(
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds
    )
    .first<{ total: number }>()
    .then((row) => row?.total ?? 0);
};

/** True while the User's shared daily canonical-work budget is already spent. */
export const dailyAuditExhausted = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<boolean> =>
  dailyAuditCount({ db, userId, current }).then((count) => count >= dailyAuditBudget);

/** Every stable SQLite abort marker an audit-table trigger raises for the shared daily budget. */
const sharedAuditLimitMarkers = ["transaction_audit_limit", "statement_audit_limit"] as const;

/** True when one D1 cause is the shared daily budget's own audit trigger refusing a write. */
export const sharedAuditLimitRefusal = (cause: unknown): boolean => {
  const detail = String(cause);
  return sharedAuditLimitMarkers.some((marker) => detail.includes(marker));
};
