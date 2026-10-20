import { Data, DateTime, Effect, Option, Schema } from "effect";
import { MediaNeedsReviewItem } from "../../../src/core/ingestion/contract";

class MediaReviewUnavailable extends Data.TaggedError("MediaReviewUnavailable")<{}> {}
const MediaReviewRow = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  created_at_ms: Schema.DateTimeUtcFromMillis,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
});
/** User-visible review is metadata-only; media locators and captions never become canonical query output. */
export const loadMediaItems = ({
  db,
  userId,
  asOf,
  limit,
}: Readonly<{ db: D1Database; userId: string; asOf: number; limit: number }>): Effect.Effect<
  Option.Option<ReadonlyArray<MediaNeedsReviewItem>>,
  MediaReviewUnavailable
> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `SELECT r.id,r.review_reason AS reason,r.review_created_at_ms AS created_at_ms,r.expires_at_ms,r.service_market,r.locale,r.time_zone FROM media_submissions r WHERE r.review_reason IS NOT NULL AND r.user_id = ? AND NOT EXISTS (SELECT 1 FROM ingestion_review_state n WHERE n.id=r.id AND n.user_id=r.user_id AND n.status!='pending') ORDER BY r.review_created_at_ms DESC,r.id DESC LIMIT ?`
          )
          .bind(userId, limit)
          .all(),
      catch: () => new MediaReviewUnavailable(),
    });
    const items: Array<MediaNeedsReviewItem> = [];
    for (const raw of rows.results) {
      const row = Schema.decodeUnknownOption(MediaReviewRow)(raw);
      if (Option.isNone(row)) return Option.none();
      const item = Schema.decodeUnknownOption(MediaNeedsReviewItem)({
        id: row.value.id,
        mediaSubmissionId: row.value.id,
        reason: row.value.reason,
        createdAt: DateTime.formatIso(row.value.created_at_ms),
        serviceMarket: row.value.service_market,
        locale: row.value.locale,
        timeZone: row.value.time_zone,
        sourceChannel: "whatsapp",
        sourceFormat: "image",
        status: row.value.expires_at_ms.epochMilliseconds > asOf ? "pending" : "expired",
      });
      if (Option.isNone(item)) return Option.none();
      items.push(item.value);
    }
    return Option.some(items);
  });
