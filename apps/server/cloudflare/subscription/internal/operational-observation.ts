import { Schema } from "effect";

const SampleSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));

/** Prepare only bounded metadata for the existing operational Work observer. */
export const pendingBillingWork = (
  input: Readonly<{
    db: D1Database;
    limit: number;
  }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `SELECT id,created,NULL AS deadline FROM (
        SELECT id,created_at_ms AS created FROM billing_attempts WHERE status='pending'
        UNION ALL SELECT id,created_at_ms AS created FROM refund_attempts WHERE status='pending'
      ) ORDER BY created LIMIT ?`
    )
    .bind(Schema.decodeSync(SampleSize)(input.limit));
