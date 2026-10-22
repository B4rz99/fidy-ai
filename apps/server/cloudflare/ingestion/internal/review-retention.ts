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
        .prepare(`UPDATE ingestion_review_items SET suggestions_json=NULL WHERE id IN
        (SELECT id FROM ingestion_review_items r WHERE NOT EXISTS (SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND evidence_expires_at_ms <= ? AND suggestions_json IS NOT NULL ORDER BY evidence_expires_at_ms,id LIMIT ?)`)
        .bind(current, maximumSweep),
      db
        .prepare(`UPDATE ingestion_review_items SET draft_json=NULL WHERE (user_id,id) IN
        (SELECT user_id,id FROM ingestion_review_items r WHERE NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND evidence_expires_at_ms<=? AND draft_json IS NOT NULL ORDER BY evidence_expires_at_ms,id LIMIT ?)`)
        .bind(current, maximumSweep),
      db
        .prepare(`UPDATE ingestion_review_items SET workspace_state=NULL,workspace_revision=NULL,draft_json=NULL,transaction_id=NULL,workspace_updated_at_ms=NULL,workspace_archive_row_ref=NULL WHERE (user_id,id) IN
        (SELECT user_id,id FROM ingestion_review_items r WHERE NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=r.user_id AND q.state NOT IN ('AwaitingReview','Draining')) AND workspace_updated_at_ms IS NOT NULL AND created_at_ms<=? ORDER BY created_at_ms,id LIMIT ?)`)
        .bind(current - historyLifetimeMilliseconds, maximumSweep),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ReviewUnavailable())
  );
