import { ReviewUnavailable } from "../contract";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type ReviewDetail,
  ReviewDraft,
  ReviewMetadata,
  ReviewStatus,
  ReviewSummary,
} from "../../../src/core/ingestion/contract";
import type { CaptureCategoryInput } from "../../categories/contract";
import type { CategoryId } from "../../../src/core/categories/contract";
import { TransactionId } from "../../../src/core/transactions/contract";

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

export const projectReviewDetailFromSnapshot = <E, R = never>({
  row,
  current,
  categorize,
}: Readonly<{
  categorize: (
    captures: ReadonlyArray<CaptureCategoryInput>
  ) => Effect.Effect<ReadonlyArray<CategoryId>, E, R>;
  row: typeof ReviewRow.Type;
  current: number;
}>): Effect.Effect<ReviewDetail, ReviewUnavailable, R> =>
  Effect.gen(function* () {
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

    const suggestions = yield* suggestReviewCategory({ categorize, draft: retainedSuggestions });
    const item = yield* projectReviewSummary({ row, current });

    return { item, revision: row.revision, draft, suggestions };
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.mapError(() => new ReviewUnavailable())
  );

export const projectReviewSummary = ({
  row,
  current,
}: Readonly<{
  row: typeof ReviewRow.Type;
  current: number;
}>): Effect.Effect<ReviewSummary, ReviewUnavailable> =>
  Effect.gen(function* () {
    const retained =
      DateTime.toEpochMillis(row.expiresAt) > current
        ? Option.orElse(row.draft_json, () => row.suggestions_json)
        : Option.none();

    const preview = yield* Effect.forEach(Option.toArray(retained), (json) =>
      Schema.decodeEffect(reviewDraftJson)(json)
    );

    return yield* Schema.decodeEffect(Schema.toCodecJson(ReviewSummary))({
      ...Option.match(Option.fromUndefinedOr(preview[0]), {
        onNone: () => ({}),
        onSome: (first) => ({
          preview: {
            counterparty: first.counterparty,
            amount: first.amount,
            ...Option.match(first.currency, {
              onNone: () => ({}),
              onSome: (currency) => ({ currency }),
            }),
          },
        }),
      }),
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
    });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.mapError(() => new ReviewUnavailable())
  );

const suggestReviewCategory = <E, R = never>({
  categorize,
  draft,
}: Readonly<{
  categorize: (
    captures: ReadonlyArray<CaptureCategoryInput>
  ) => Effect.Effect<ReadonlyArray<CategoryId>, E, R>;
  draft: Option.Option<ReviewDraft>;
}>): Effect.Effect<Option.Option<ReviewDraft>, ReviewUnavailable, R> =>
  Effect.gen(function* () {
    if (Option.isNone(draft) || Option.isNone(draft.value.direction)) return draft;
    const suggestion = draft.value;

    const categories = yield* categorize([
      {
        caller: suggestion.categoryId,
        counterparty:
          suggestion.counterparty === "" ? Option.none() : Option.some(suggestion.counterparty),
        direction: draft.value.direction.value,
      },
    ]);

    return Option.some({ ...suggestion, categoryId: Option.fromUndefinedOr(categories[0]) });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.mapError(() => new ReviewUnavailable())
  );
