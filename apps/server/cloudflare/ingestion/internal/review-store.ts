import { ReviewUnavailable } from "../contract";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type ReviewDetail,
  ReviewDraft,
  ReviewMetadata,
  ReviewStatus,
  ReviewSummary,
} from "../../../src/core/ingestion/contract";
import { categorizeCaptures } from "../../categories/operations";
import { TransactionId } from "../../../src/core/transactions/contract";

export const reviewCompletion = `INSERT INTO ingestion_review_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
export const ReviewRow = Schema.Struct({
  ...ReviewMetadata.fields,
  status: ReviewStatus,
  createdAt: Schema.DateTimeUtcFromMillis,
  expiresAt: Schema.DateTimeUtcFromMillis,
  transactionId: Schema.OptionFromNullOr(TransactionId),
  revision: Schema.Int,
  draft_json: Schema.OptionFromNullOr(Schema.String),
  suggestions_json: Schema.OptionFromNullOr(Schema.String),
});
export const reviewProjection = `id, source, reason, time_zone AS timeZone,
  CASE WHEN status != 'created' AND expires_at_ms <= ? THEN 'expired' ELSE status END AS status,
  created_at_ms AS createdAt, expires_at_ms AS expiresAt, transaction_id AS transactionId,revision,draft_json,suggestions_json`;
export const reviewDraftJson = Schema.fromJsonString(Schema.toCodecJson(ReviewDraft));

export const readReviewDetail = ({
  db,
  userId,
  id,
  current,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  current: number;
}>): Effect.Effect<Option.Option<ReviewDetail>, ReviewUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT ${reviewProjection}
    FROM ingestion_review_sources WHERE user_id = ? AND id = ?`)
        .bind(current, userId, id)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(ReviewRow)(raw);
    const draft =
      DateTime.toEpochMillis(row.expiresAt) > current
        ? yield* Effect.forEach(Option.toArray(row.draft_json), (json) =>
            Schema.decodeEffect(reviewDraftJson)(json)
          ).pipe(Effect.map((values) => Option.fromUndefinedOr(values[0])))
        : Option.none();
    const retainedSuggestions =
      DateTime.toEpochMillis(row.expiresAt) > current
        ? yield* Effect.forEach(Option.toArray(row.suggestions_json), (json) =>
            Schema.decodeEffect(reviewDraftJson)(json)
          ).pipe(Effect.map((values) => Option.fromUndefinedOr(values[0])))
        : Option.none();
    const suggestions = yield* suggestReviewCategory({ db, userId, draft: retainedSuggestions });
    const item = yield* projectReviewSummary(row);
    return Option.some({ item, revision: row.revision, draft, suggestions });
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));

export const projectReviewSummary = (
  row: Omit<typeof ReviewRow.Type, "draft_json" | "suggestions_json">
): Effect.Effect<ReviewSummary, ReviewUnavailable> =>
  Schema.decodeEffect(Schema.toCodecJson(ReviewSummary))({
    revision: row.revision,
    id: row.id,
    source: row.source,
    reason: row.reason,
    timeZone: row.timeZone,
    createdAt: DateTime.formatIso(row.createdAt),
    expiresAt: DateTime.formatIso(row.expiresAt),
    status: row.status,
    ...Option.match(row.transactionId, {
      onNone: () => ({}),
      onSome: (transactionId) => ({ transactionId }),
    }),
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));

/** Resolve current Category instructions without altering retained extraction facts or User drafts. */
const suggestReviewCategory = ({
  db,
  userId,
  draft,
}: Readonly<{
  db: D1Database;
  userId: string;
  draft: Option.Option<ReviewDraft>;
}>): Effect.Effect<Option.Option<ReviewDraft>, ReviewUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(draft) || Option.isNone(draft.value.direction)) return draft;
    const suggestion = draft.value;
    const categories = yield* categorizeCaptures({
      db,
      userId,
      captures: [
        {
          caller: suggestion.categoryId,
          counterparty:
            suggestion.counterparty === "" ? Option.none() : Option.some(suggestion.counterparty),
          direction: draft.value.direction.value,
        },
      ],
    });
    return Option.some({ ...suggestion, categoryId: Option.fromUndefinedOr(categories[0]) });
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));
