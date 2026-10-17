import { ReviewUnavailable } from "../contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { type ReviewCommand } from "../../../src/core/ingestion/contract";
import { CapturedInterpretationContext } from "../../../src/core/interpretation-evidence/contract";
import type { ReviewEditWork } from "../contract";
import { categorizeCaptures } from "../../categories/operations";
import { prepareReviewedCapture } from "../../transactions/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { newId } from "../../secret-material/operations";

export type CreateReview = Extract<ReviewCommand, { _tag: "Create" }>;
export const reviewedCapture = ({
  work,
  command,
  guard,
}: Readonly<{
  work: ReviewEditWork["work"];
  command: CreateReview;
  guard: OwnedStatement;
}>): Effect.Effect<
  Readonly<{
    statements: ReadonlyArray<D1PreparedStatement>;
    transactionId: string;
    categoryId: string;
  }>,
  ReviewUnavailable
> =>
  Effect.gen(function* () {
    if (DateTime.toEpochMillis(command.extraction.occurredAt) > work.current) {
      return yield* new ReviewUnavailable();
    }
    const raw = yield* Effect.tryPromise(() =>
      work.db
        .prepare(
          `SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM ingestion_review_sources WHERE user_id=? AND id=?`
        )
        .bind(work.subject.userId, command.id)
        .first()
    );
    const context = yield* Schema.decodeUnknownEffect(CapturedInterpretationContext)(raw);
    const categories = yield* categorizeCaptures({
      db: work.db,
      userId: work.subject.userId,
      captures: [
        {
          caller: command.categoryId,
          counterparty: command.extraction.counterparty,
          direction: command.extraction.direction,
        },
      ],
    });
    const categoryId = categories[0];
    if (categoryId === undefined) return yield* new ReviewUnavailable();
    const transactionId = newId();
    const statements = prepareReviewedCapture({
      db: work.db,
      userId: work.subject.userId,
      transactionId,
      attestationId: newId(),
      extraction: command.extraction,
      categoryId,
      sourceGuard: guard,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(work.current)),
      context,
      reviewItemId: command.id,
      userProvidedFields: providedFields(command),
    });
    return { statements, transactionId, categoryId };
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));

const providedFields = (
  command: CreateReview
): ReadonlyArray<"money" | "direction" | "occurredAt" | "counterparty" | "categoryId"> => [
  "money",
  "direction",
  "occurredAt",
  ...Option.toArray(command.extraction.counterparty).map(() => "counterparty" as const),
  ...Option.toArray(command.categoryId).map(() => "categoryId" as const),
];
