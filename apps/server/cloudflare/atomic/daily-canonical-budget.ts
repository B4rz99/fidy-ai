const utcDayMilliseconds = 86_400_000;

/** Matches the 256-entry stable-User triggers rebuilt in 0018_batch_envelope_audit.sql. */
export const dailyAuditBudget = 256;

/**
 * The canonical AuditLogEntry rows one User's UTC day counts: transaction, PAT, category, Memory,
 * statement submission, statement review. Batch-envelope refusals are excluded; every audit trigger counts the
 * same union, so this read and the triggers agree about what the budget covers.
 */
const auditDayCount = `SELECT
      (SELECT count(*) FROM transaction_audit WHERE user_id = ?
        AND operation != 'operations.executeAtomicBatch' AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM pat_audit WHERE user_id = ?
        AND operation != 'operations.executeAtomicBatch'
        AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
        AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM category_audit WHERE user_id = ?
        AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM memory_audit WHERE user_id = ?
        AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM statement_submission_audit WHERE user_id = ?
        AND occurred_at_ms >= ? AND occurred_at_ms < ?)
      + (SELECT count(*) FROM statement_review_audit WHERE user_id = ?
        AND occurred_at_ms >= ? AND occurred_at_ms < ?) AS total`;

/** How many canonical audit rows one User has committed in the UTC day containing `current`. */
export const dailyAuditCount = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<number> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return db
    .prepare(auditDayCount)
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
