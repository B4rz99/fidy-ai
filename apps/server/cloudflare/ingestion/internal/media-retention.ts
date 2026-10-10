import { Data, Effect } from "effect";

class MediaRetentionUnavailable extends Data.TaggedError("MediaRetentionUnavailable")<{}> {}
const retentionBatchSize = 512;
const accountabilityLifetimeMs = 31536000000;
const contentLifetimeMs = 2592000000;
/** Clear expired locators/captions and pending identities after 30 days; retain metadata-only review and accountability for one year. Each scheduled action is bounded. */
export const sweepMedia = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, MediaRetentionUnavailable> =>
  Effect.tryPromise({
    try: () => {
      const current = now;
      return db.batch([
        db
          .prepare(
            "DELETE FROM media_submission_outbox WHERE submission_id IN (SELECT submission_id FROM media_submission_outbox WHERE created_at_ms <= ? ORDER BY created_at_ms,submission_id LIMIT ?)"
          )
          .bind(current - contentLifetimeMs, retentionBatchSize),
        db
          .prepare(
            "UPDATE media_submissions SET media_id = NULL,caption = NULL WHERE id IN (SELECT id FROM media_submissions WHERE expires_at_ms <= ? AND (media_id IS NOT NULL OR caption IS NOT NULL) ORDER BY expires_at_ms,id LIMIT ?) AND (media_id IS NOT NULL OR caption IS NOT NULL)"
          )
          .bind(current, retentionBatchSize),
        db
          .prepare(
            "DELETE FROM media_submissions WHERE id IN (SELECT id FROM media_submissions WHERE accepted_at_ms <= ? ORDER BY accepted_at_ms,id LIMIT ?)"
          )
          .bind(current - accountabilityLifetimeMs, retentionBatchSize),
      ]);
    },
    catch: () => new MediaRetentionUnavailable(),
  }).pipe(Effect.asVoid);
