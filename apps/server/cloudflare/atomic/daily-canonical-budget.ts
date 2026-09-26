import { Schema } from "effect";

export const utcDayMilliseconds = 86_400_000;
const DailyAuditTotal = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Matches the 256-entry stable-User triggers rebuilt in 0018_batch_envelope_audit.sql. */
export const dailyAuditBudget = 256;

/**
 * The canonical AuditLogEntry rows one User's UTC day counts. Batch-envelope refusals are
 * excluded; each audit trigger counts the same six-table union.
 */
export const auditDayCountExpression = `(SELECT count(*) FROM transaction_audit WHERE user_id = ?
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
      AND occurred_at_ms >= ? AND occurred_at_ms < ?)`;

/** Parameters for the six-table UTC-day count; callers use this with `auditDayCountExpression` in D1. */
export const auditDayBindings = ({
  userId,
  current,
}: Readonly<{ userId: string; current: number }>): ReadonlyArray<string | number> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return Array.from({ length: 6 }).flatMap(() => [userId, start, start + utcDayMilliseconds]);
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

/** True while the User's shared daily canonical-work budget is already spent. */
export const dailyAuditExhausted = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<boolean> =>
  dailyAuditCount({ db, userId, current }).then((count) => count >= dailyAuditBudget);
