import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { ReviewUnavailable } from "../contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import PostalMime from "postal-mime";
import { ReviewDraft } from "../../../src/core/ingestion/contract";
import { CapturedInterpretationContext } from "../../../src/core/interpretation-evidence/contract";
import { interpretNotificationEmail } from "../../../src/shell/ingestion/operations";
import {
  type QueryCaller,
  transactionFailure,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { categorizeCaptures } from "../../categories/operations";
import { readReviewDetail } from "./review-store";
import { commitReviewRead, reviewAudit } from "./review-audit";

const maximumEmailBytes = 1_048_576;
const itemPosition = -2;
const Email = Schema.Struct({
  receipt_id: Schema.String,
  object_key: Schema.String,
  created_at_ms: Schema.Int,
  time_zone: Schema.String,
});
type Email = typeof Email.Type;
const interpretReviewEmail = (
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  receipt: Email
): ReturnType<typeof interpretNotificationEmail> =>
  Effect.gen(function* () {
    const context = yield* Schema.decodeEffect(CapturedInterpretationContext)({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: receipt.time_zone,
    });
    return yield* interpretNotificationEmail({
      context,
      content: {
        receivedEmailId: receipt.receipt_id,
        from: parsed.from?.address ?? "",
        to: (parsed.to ?? []).map((value) => value.address ?? ""),
        subject: parsed.subject ?? "",
        ...(parsed.text === undefined ? {} : { text: parsed.text }),
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
        inlineImages: [],
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(receipt.created_at_ms)),
      },
    });
  }).pipe(
    Effect.orElseSucceed(() => ({
      _tag: "NeedsReview" as const,
      reason: "canonical-validation-failed" as const,
    }))
  );
const emailSuggestion = ({
  db,
  userId,
  id,
  bucket,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  bucket: Option.Option<R2Bucket>;
}>): Effect.Effect<Option.Option<ReviewDraft>, ReviewUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(bucket)) return Option.none();
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT s.id AS receipt_id,s.object_key,r.created_at_ms,s.time_zone FROM ingestion_review_items r JOIN forwarded_email_receipts s ON s.user_id=r.user_id AND s.id=r.email_receipt_id WHERE r.source_kind='email' AND r.id=? AND r.user_id=?`
        )
        .bind(id, userId)
        .first()
    );
    const receipt = yield* Schema.decodeUnknownEffect(Email)(raw);
    const object = yield* Effect.tryPromise(() => bucket.value.get(receipt.object_key));
    if (object === null || object.size > maximumEmailBytes) return Option.none();
    const bytes = yield* Effect.tryPromise(() => object.arrayBuffer());
    if (bytes.byteLength > maximumEmailBytes) return Option.none();
    const parsed = yield* Effect.tryPromise(() => PostalMime.parse(bytes));
    const interpreted = yield* interpretReviewEmail(parsed, receipt);
    if (interpreted._tag !== "Interpreted") return Option.none();
    const extraction = interpreted.extraction;
    const categories = yield* categorizeCaptures({
      db,
      userId,
      captures: [
        {
          caller: Option.none(),
          counterparty: extraction.counterparty,
          direction: extraction.direction,
        },
      ],
    });
    return Option.some({
      amount: encodeMoneyAmount(extraction.money.amount),
      currency: Option.some(extraction.money.currency),
      direction: Option.some(extraction.direction),
      counterparty: Option.getOrElse(extraction.counterparty, () => ""),
      occurredAt: DateTime.formatIso(extraction.occurredAt),
      categoryId: Option.fromUndefinedOr(categories[0]),
      userProvidedFields: [],
    });
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));

/** A retry reads retained originals through the installed parser; it never replays Transaction creation. */
export const browseReviewSuggestions = ({
  db,
  subject,
  request,
  bucket,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
  bucket: Option.Option<R2Bucket>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const id = new URL(request.url).pathname.split("/").at(itemPosition) ?? "";
    const detail = yield* readReviewDetail({ db, userId: subject.userId, id, current });
    if (Option.isNone(detail) || detail.value.item.expiresAt.epochMilliseconds <= current) {
      yield* commitReviewRead({
        work: { db, subject, current },
        operation: "ingestion.getReviewSuggestions",
        accepted: false,
      });
      return transactionFailure({
        code: "not_found",
        status: 404,
        message: "El elemento venció o no está disponible. Vuelve a enviarlo.",
      });
    }
    const suggestion =
      detail.value.item.source === "email"
        ? yield* emailSuggestion({ db, userId: subject.userId, id, bucket })
        : detail.value.suggestions;
    yield* Effect.tryPromise(() =>
      db.batch([
        ...reviewAudit({
          work: { db, subject, current: transactionNow() },
          operation: "ingestion.getReviewSuggestions",
          accepted: Option.isSome(suggestion),
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ])
    );
    if (
      Option.isNone(suggestion) ||
      detail.value.item.expiresAt.epochMilliseconds <= transactionNow()
    ) {
      return transactionUnavailable();
    }
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(ReviewDraft))(suggestion.value);
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
