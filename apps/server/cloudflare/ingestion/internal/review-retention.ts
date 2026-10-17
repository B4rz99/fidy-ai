import { ReviewUnavailable } from "../contract";
import { Effect } from "effect";

const maximumSweep = 512;
const historyLifetimeMilliseconds = 31_536_000_000;
/** Draft retention ends at the immutable original deadline, including skipped and created items. */
export const sweepReviewDrafts = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<void, ReviewUnavailable> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(`UPDATE ingestion_review_state SET draft_json=NULL WHERE (user_id,id) IN
      (SELECT user_id,id FROM ingestion_review_state r WHERE NOT EXISTS (SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND expires_at_ms <= ? AND draft_json IS NOT NULL ORDER BY expires_at_ms,id LIMIT ?)`)
        .bind(current, maximumSweep),
      db
        .prepare(`UPDATE statement_needs_review SET review_suggestions_json=NULL WHERE id IN
        (SELECT id FROM statement_needs_review r WHERE NOT EXISTS (SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND evidence_expires_at_ms <= ? AND review_suggestions_json IS NOT NULL ORDER BY evidence_expires_at_ms,id LIMIT ?)`)
        .bind(current, maximumSweep),
      db
        .prepare(`DELETE FROM ingestion_review_state WHERE (user_id,id) IN
      (SELECT user_id,id FROM ingestion_review_state r WHERE NOT EXISTS (SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND created_at_ms <= ? ORDER BY created_at_ms,id LIMIT ?)`)
        .bind(current - historyLifetimeMilliseconds, maximumSweep),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ReviewUnavailable())
  );
