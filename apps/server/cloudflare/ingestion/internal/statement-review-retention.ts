import { Clock, Effect } from "effect";
import { StatementProcessingUnavailable } from "../contract";

// The per-minute sweep clears the entire globally admitted raw-evidence capacity.
export const maximumRetainedReviewEvidence = 5_000;

/** Expire raw review material while retaining the item, classification and accounting. */
export const expireStatementReviewEvidence = ({
  DB,
}: Readonly<{ DB: D1Database }>): Effect.Effect<void, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        DB.batch([
          DB.prepare(`UPDATE statement_hosted_origins SET abandoned_at_ms = ?
      WHERE submission_id IN (SELECT submission_id FROM statement_hosted_origins
        WHERE abandoned_at_ms IS NULL AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)`).bind(
            current,
            current,
            maximumRetainedReviewEvidence
          ),
          DB.prepare(`UPDATE statement_clarifications SET state = 'abandoned', ended_at_ms = ?
      WHERE submission_id IN (SELECT submission_id FROM statement_clarifications
        WHERE state = 'awaiting' AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)`).bind(
            current,
            current,
            maximumRetainedReviewEvidence
          ),
          DB.prepare(`UPDATE statement_needs_review
    SET status = 'expired', original_evidence = NULL, known_money = NULL
    WHERE id IN (SELECT id FROM statement_needs_review
      WHERE status = 'pending' AND evidence_expires_at_ms <= ?
      ORDER BY evidence_expires_at_ms, id LIMIT ?)`).bind(current, maximumRetainedReviewEvidence),
        ]),
      catch: () => new StatementProcessingUnavailable(),
    }).pipe(Effect.asVoid, Effect.uninterruptible);
  });
