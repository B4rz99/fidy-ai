import { currentMillis } from "../pats/pat-shared";

// The per-minute sweep clears the entire globally admitted raw-evidence capacity.
export const maximumRetainedReviewEvidence = 5_000;

/** Expire raw review material while retaining the item, classification and accounting. */
export const expireStatementReviewEvidence = ({
  DB,
}: Readonly<{ DB: D1Database }>): Promise<void> =>
  DB.prepare(`UPDATE statement_needs_review
    SET status = 'expired', original_evidence = NULL, known_money = NULL
    WHERE id IN (SELECT id FROM statement_needs_review
      WHERE status = 'pending' AND evidence_expires_at_ms <= ?
      ORDER BY evidence_expires_at_ms, id LIMIT ?)`)
    .bind(currentMillis(), maximumRetainedReviewEvidence)
    .run()
    .then(() => undefined);
