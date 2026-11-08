import { type Cause, Effect, Option, Schema } from "effect";
import type {
  CanonicalBrowserSourceRead,
  CanonicalReadCompletion,
} from "../../canonical-admission/contract";
import { prepareCanonicalBrowserQueryFinalization } from "../../canonical-admission/operations";
import type { AuthenticatedWebSession } from "../../web-session/contract";
import { ReviewMaterial } from "../../../src/shell/ingestion/contract";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import {
  transactionFailure,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { reviewAudit } from "./review-audit";
import { MaterialRow, materialSelection, materialText, unavailable } from "./review-material";

const materialIdPosition = -2;
const maximumMaterialCharacters = 100_000;
const Expires = Schema.Struct({ expires_at_ms: Schema.Finite });
type Original = Option.Option<typeof MaterialRow.Type>;
type MaterialWork = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  statements: ReadonlyArray<D1PreparedStatement>;
  subject: AuthenticatedWebSession;
  completion: CanonicalReadCompletion;
}>;

const sameOriginal = (first: Original, last: Original): boolean =>
  Option.isSome(first) &&
  Option.isSome(last) &&
  Option.getOrNull(first.value.text) === Option.getOrNull(last.value.text) &&
  Option.getOrNull(first.value.object_key) === Option.getOrNull(last.value.object_key);

const disclosedMaterial = ({
  rows,
  original,
  text,
}: Readonly<{
  rows: ReadonlyArray<D1Result>;
  original: Original;
  text: Option.Option<string>;
}>): typeof ReviewMaterial.Type => {
  const live = Schema.decodeUnknownOption(Expires)(rows[0]?.results[0]);
  if (Option.isNone(live) || live.value.expires_at_ms <= transactionNow()) {
    return { available: false, reason: "expired" };
  }
  const retained = Schema.decodeUnknownOption(MaterialRow)(rows[1]?.results[0]);
  if (!sameOriginal(original, retained)) return unavailable;
  return Option.match(text, {
    onNone: () => unavailable,
    onSome: (value) => ({
      available: true,
      text: value.slice(0, maximumMaterialCharacters),
      truncated: value.length > maximumMaterialCharacters,
    }),
  });
};

const finishMaterial = ({
  work,
  found,
  original,
  text,
}: Readonly<{
  work: MaterialWork;
  found: Option.Option<typeof Expires.Type>;
  original: Original;
  text: Option.Option<string>;
}>): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const { db, subject, completion } = work;
    const final = prepareCanonicalBrowserQueryFinalization({
      db,
      subject,
      completion,
      accounting: (current) => [
        ...reviewAudit({
          work: { db, subject, current },
          operation: "ingestion.getReviewMaterial",
          accepted: Option.isSome(found),
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ],
    });
    const finishing = yield* final.finalization();
    // Recheck eligibility and locator after external bytes, atomically with fresh access and accounting.
    const rows = yield* Effect.tryPromise(() =>
      db.batch([...work.statements, ...finishing.statements])
    ).pipe(Effect.uninterruptible);
    finishing.committed(rows.slice(work.statements.length));
    if (Option.isNone(found)) {
      return final.present(
        transactionFailure({ code: "not_found", status: 404, message: "Elemento no disponible." })
      );
    }
    const data = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewMaterial))(
      disclosedMaterial({ rows, original, text })
    );
    return final.present(Response.json({ data, next: [] }, { headers: transactionNoStore }));
  });

const presentMaterial = (
  work: MaterialWork,
  rows: ReadonlyArray<D1Result>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const found = Schema.decodeUnknownOption(Expires)(rows[0]?.results[0]);
    const original = Schema.decodeUnknownOption(MaterialRow)(rows[1]?.results[0]);
    const text =
      Option.isSome(found) &&
      found.value.expires_at_ms > transactionNow() &&
      Option.isSome(original)
        ? yield* materialText({ row: original.value, bucket: work.bucket })
        : Option.none<string>();
    return yield* finishMaterial({ work, found, original, text });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Original eligibility and locator join admission; unused draft interpretation starts no read. */
export const prepareBoundReviewMaterial =
  ({
    request,
    bucket,
  }: Readonly<{
    request: Request;
    bucket: Option.Option<R2Bucket>;
  }>): CanonicalBrowserSourceRead =>
  ({ db, reservation: users }) => {
    const id = new URL(request.url).pathname.split("/").at(materialIdPosition) ?? "";
    const material = materialSelection.replaceAll(
      "user_id=?",
      `user_id IN (SELECT userId FROM (${users.sql}))`
    );
    const statements = [
      db
        .prepare(
          `SELECT expires_at_ms FROM ingestion_review_sources WHERE id=? AND user_id IN (SELECT userId FROM (${users.sql}))`
        )
        .bind(id, ...users.params),
      db.prepare(material).bind(...users.params, id, ...users.params, id, ...users.params, id),
    ];
    return {
      statements,
      unavailable: Option.none(),
      present: (rows, subject, completion) =>
        presentMaterial({ db, bucket, statements, subject, completion }, rows),
    };
  };
