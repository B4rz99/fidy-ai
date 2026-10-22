import { Clock, Effect } from "effect";
import { StatementProcessingUnavailable } from "../contract";

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
          DB.prepare(`UPDATE statement_submissions SET hosted_abandoned_at_ms = ?
      WHERE id IN (SELECT id FROM statement_submissions
        WHERE hosted_session_id IS NOT NULL AND hosted_abandoned_at_ms IS NULL AND hosted_expires_at_ms <= ? ORDER BY hosted_expires_at_ms LIMIT ?)`).bind(
            current,
            current,
            maximumRetainedReviewEvidence
          ),
          DB.prepare(`UPDATE statement_submissions SET clarification_state = 'abandoned', clarification_ended_at_ms = ?
      WHERE id IN (SELECT id FROM statement_submissions
        WHERE clarification_state = 'awaiting' AND clarification_expires_at_ms <= ? ORDER BY clarification_expires_at_ms LIMIT ?)`).bind(
            current,
            current,
            maximumRetainedReviewEvidence
          ),
          DB.prepare(`UPDATE ingestion_review_items
    SET evidence_state = 'expired', original_evidence = NULL, known_money_json = NULL, suggestions_json = NULL
    WHERE id IN (SELECT id FROM ingestion_review_items
      WHERE source_kind='statement' AND evidence_state = 'retained' AND evidence_expires_at_ms <= ?
      ORDER BY evidence_expires_at_ms, id LIMIT ?)`).bind(current, maximumRetainedReviewEvidence),
        ]),
      catch: () => new StatementProcessingUnavailable(),
    }).pipe(Effect.asVoid, Effect.uninterruptible);
  });
