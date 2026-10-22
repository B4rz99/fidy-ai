import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { ReviewUnavailable } from "../contract";
import { Effect, Option, Schema } from "effect";
import PostalMime from "postal-mime";
import { ReviewMaterial } from "../../../src/shell/ingestion/contract";
import {
  type QueryCaller,
  callerAuthority,
  transactionFailure,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { commitReviewRead, reviewAudit } from "./review-audit";
import { readReviewDetail } from "./review-store";

const materialIdPosition = -2;
const maximumMaterialCharacters = 100_000;
const maximumEmailBytes = 1_048_576;
const MaterialRow = Schema.Struct({
  text: Schema.OptionFromNullOr(Schema.String),
  object_key: Schema.OptionFromNullOr(Schema.String),
});
const unavailable = { available: false, reason: "unavailable" } as const;
const findMaterial = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Effect.Effect<
  Option.Option<typeof MaterialRow.Type>,
  ReviewUnavailable
> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT original_evidence AS text,NULL AS object_key FROM statement_review_context WHERE user_id=? AND id=?
    UNION ALL SELECT NULL,s.object_key FROM ingestion_review_items r JOIN forwarded_email_receipts s ON s.user_id=r.user_id AND s.id=r.email_receipt_id WHERE r.source_kind='email' AND r.user_id=? AND r.id=?
    UNION ALL SELECT s.caption,NULL FROM ingestion_review_items r JOIN media_submissions s ON s.user_id=r.user_id AND s.id=r.media_submission_id WHERE r.source_kind='media' AND r.user_id=? AND r.id=?`)
      .bind(userId, id, userId, id, userId, id)
      .first()
  ).pipe(
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(MaterialRow)(raw).pipe(Effect.asSome)
    ),
    Effect.mapError(() => new ReviewUnavailable())
  );
const materialText = (
  row: typeof MaterialRow.Type,
  bucket: Option.Option<R2Bucket>
): Effect.Effect<Option.Option<string>, ReviewUnavailable> =>
  Effect.gen(function* () {
    if (Option.isSome(row.text)) return row.text;
    if (Option.isNone(row.object_key) || Option.isNone(bucket)) return Option.none();
    const objectKey = row.object_key.value;
    const object = yield* Effect.tryPromise(() => bucket.value.get(objectKey));
    if (object === null || object.size > maximumEmailBytes) return Option.none();
    const bytes = yield* Effect.tryPromise(() => object.arrayBuffer());
    if (bytes.byteLength > maximumEmailBytes) return Option.none();
    const email = yield* Effect.tryPromise(() => PostalMime.parse(bytes));
    return Option.fromUndefinedOr(email.text ?? email.html);
  }).pipe(Effect.mapError(() => new ReviewUnavailable()));

const liveMaterialCaller = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<
  boolean,
  ReviewUnavailable
> => {
  const authority = callerAuthority({ subject, current: transactionNow() });
  return Effect.tryPromise(() =>
    db
      .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(...authority.bindings)
      .first()
  ).pipe(
    Effect.map((value) => value !== null),
    Effect.mapError(() => new ReviewUnavailable())
  );
};
/** WebSession-only policy prevents personal originals entering agent outputs or retained transcripts. */
export const browseReviewMaterial = ({
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
    const id = new URL(request.url).pathname.split("/").at(materialIdPosition) ?? "";
    const current = transactionNow();
    const found = yield* readReviewDetail({ db, userId: subject.userId, id, current });
    if (Option.isNone(found)) {
      yield* commitReviewRead({
        work: { db, subject, current },
        operation: "ingestion.getReviewMaterial",
        accepted: false,
      });
      return transactionFailure({
        code: "not_found",
        status: 404,
        message: "Elemento no disponible.",
      });
    }
    const original =
      found.value.item.expiresAt.epochMilliseconds <= current
        ? Option.none()
        : yield* findMaterial({ db, userId: subject.userId, id });
    const text = Option.isSome(original)
      ? yield* materialText(original.value, bucket)
      : Option.none();
    if (!(yield* liveMaterialCaller({ db, subject }))) return transactionUnavailable();
    yield* Effect.tryPromise(() =>
      db.batch([
        ...reviewAudit({
          work: { db, subject, current: transactionNow() },
          operation: "ingestion.getReviewMaterial",
          accepted: true,
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ])
    );
    const data =
      found.value.item.expiresAt.epochMilliseconds <= transactionNow()
        ? { available: false, reason: "expired" }
        : Option.match(text, {
            onNone: () => unavailable,
            onSome: (value) => ({
              available: true,
              text: value.slice(0, maximumMaterialCharacters),
              truncated: value.length > maximumMaterialCharacters,
            }),
          });
    const encoded = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewMaterial))(data);
    return Response.json({ data: encoded, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
