import { Schema } from "effect";

const SampleSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));

const pendingQueries: Readonly<Record<"statement" | "forwardedEmail", string>> = {
  statement: `SELECT id, submitted_at_ms AS created, retention_expires_at_ms AS deadline FROM statement_submissions WHERE status IN ('queued', 'processing') ORDER BY submitted_at_ms LIMIT ?`,
  forwardedEmail: `SELECT r.id, r.received_at_ms AS created, r.expires_at_ms AS deadline
    FROM forwarded_email_receipts AS r WHERE r.state IN ('storing', 'queued')
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes AS o WHERE o.receipt_id = r.id)
    ORDER BY r.received_at_ms LIMIT ?`,
};

/** Bound metadata observation to the same oldest eight pending owner records. */
export const pendingIngestionWork = (
  input: Readonly<{ db: D1Database; operation: "statement" | "forwardedEmail"; limit: number }>
): D1PreparedStatement =>
  input.db
    .prepare(pendingQueries[input.operation])
    .bind(Schema.decodeSync(SampleSize)(input.limit));
/** Observe only due retention instants, never raw material or identities. */
export const overdueIngestionRetention = (
  input: Readonly<{ db: D1Database; now: number; limit: number }>
): D1PreparedStatement =>
  input.db
    .prepare(`SELECT expires FROM (
          SELECT expires_at_ms AS expires FROM statement_staging_objects
          WHERE status IN ('pending', 'available', 'deleting') AND object_deleted_at_ms IS NULL AND expires_at_ms <= ?
          UNION ALL SELECT s.retention_expires_at_ms AS expires FROM statement_staging_objects AS o
          JOIN statement_submissions AS s ON s.staging_id = o.id
          WHERE o.status = 'published' AND o.object_deleted_at_ms IS NULL AND s.retention_expires_at_ms <= ?
          UNION ALL SELECT expires_at_ms AS expires FROM forwarded_email_receipts
          WHERE state IN ('storing', 'queued') AND expires_at_ms <= ?
          UNION ALL SELECT evidence_expires_at_ms AS expires FROM statement_needs_review
          WHERE status = 'pending' AND evidence_expires_at_ms <= ?
            AND (original_evidence IS NOT NULL OR known_money IS NOT NULL)
        ) ORDER BY expires LIMIT ?`)
    .bind(input.now, input.now, input.now, input.now, Schema.decodeSync(SampleSize)(input.limit));
