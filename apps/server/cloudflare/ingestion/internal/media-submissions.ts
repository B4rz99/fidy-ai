import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { AllowanceMeter } from "../../../src/core/quotas/contract";
import { whatsAppIdentityQuery } from "../../identity/operations";
import { prepareUserContext } from "../../identity/user-context/operations";
import {
  decodeQuotaStatus,
  prepareAuthorizedQuotaRead,
  prepareConsumption,
  quotaFailure,
} from "../../quotas/operations";
import { newId } from "../../secret-material/operations";
import type { MediaAdmissionInput } from "../contract";
import { mediaEvidenceLifetimeMs } from "./media-retention-policy";

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_LIMITED = 429;
const HTTP_UNAVAILABLE = 503;
const hexadecimalRadix = 16;
class MediaUnavailable extends Data.TaggedError("MediaUnavailable")<{ cause: unknown }> {}
const noStore = { "cache-control": "no-store" };
const failure = (code: string, status: number): Response =>
  Response.json(
    { error: { code, message: "Media submission could not be admitted." }, next: [] },
    { status, headers: noStore }
  );
const io = <A>(run: () => Promise<A>): Effect.Effect<A, MediaUnavailable> =>
  Effect.tryPromise({ try: run, catch: (cause) => new MediaUnavailable({ cause }) });
const StoredMedia = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  input_digest: Schema.String,
});
const authorityFor = ({ userId, event }: MediaAdmissionInput): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: whatsAppIdentityQuery({
      userId,
      portfolioId: event.caller.businessPortfolioId,
      bsuid: event.caller.businessScopedUserId,
    }),
  });
const findMedia = (
  input: MediaAdmissionInput
): Effect.Effect<Option.Option<typeof StoredMedia.Type>, MediaUnavailable> => {
  const authority = authorityFor(input);
  return io(() =>
    input.db
      .prepare(
        `SELECT id,input_digest FROM media_submissions WHERE user_id = ? AND portfolio_id = ? AND message_id = ? AND EXISTS (${authority.sql})`
      )
      .bind(
        input.userId,
        input.event.caller.businessPortfolioId,
        input.event.messageEvidence.providerMessageId,
        ...authority.params
      )
      .first()
  ).pipe(Effect.map(Schema.decodeUnknownOption(StoredMedia)));
};
type MediaPublication = Readonly<{
  input: MediaAdmissionInput;
  id: string;
  current: number;
  mediaId: string;
  caption: string;
  inputDigest: string;
}>;
const snapshot = ({
  input,
  id,
  current,
  mediaId,
  caption,
  inputDigest,
}: MediaPublication): D1PreparedStatement => {
  const { db, userId, event } = input;
  const authority = authorityFor(input);
  return prepareUserContext({
    db,
    userId,
    statement: {
      sql: `INSERT INTO media_submissions SELECT ?,userId,?,?,?,?,?,NULLIF(?,''),?,?,serviceMarket,locale,timeZone FROM identity_user_context WHERE userId = ? AND EXISTS (${authority.sql})`,
      params: [
        id,
        event.caller.businessPortfolioId,
        event.caller.businessScopedUserId,
        event.messageEvidence.providerMessageId,
        inputDigest,
        mediaId,
        caption,
        current,
        current + mediaEvidenceLifetimeMs,
        userId,
        ...authority.params,
      ],
    },
  });
};
const publication = ({
  input,
  id,
  current,
  mediaId,
  caption,
  inputDigest,
}: MediaPublication): ReadonlyArray<D1PreparedStatement> => {
  const { db, userId } = input;
  const authority = authorityFor(input);
  return [
    db
      .prepare(
        "INSERT INTO media_publication_assertions VALUES (?,1,CASE WHEN (SELECT count(*) FROM media_submission_outbox WHERE user_id = ?) < 50 AND (SELECT count(*) FROM media_submission_outbox) < 2500 THEN 1 ELSE 0 END)"
      )
      .bind(id, userId),
    ...prepareConsumption({
      db,
      userId,
      allowance: "media_submission",
      identity: id,
      current,
      authority,
    }),
    snapshot({ input, id, current, mediaId, caption, inputDigest }),
    db
      .prepare(
        "UPDATE media_publication_assertions SET published = CASE WHEN EXISTS (SELECT 1 FROM media_submissions WHERE id = ? AND user_id = ?) THEN 1 ELSE 0 END WHERE id = ?"
      )
      .bind(id, userId, id),
    db
      .prepare(
        "INSERT INTO media_submission_audit SELECT id,user_id,'accepted',accepted_at_ms FROM media_submissions WHERE id = ?"
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO media_submission_outbox SELECT id,user_id,accepted_at_ms FROM media_submissions WHERE id = ?"
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO media_needs_review SELECT id,user_id,'extraction-unavailable',accepted_at_ms FROM media_submissions WHERE id = ?"
      )
      .bind(id),
    db.prepare("DELETE FROM media_publication_assertions WHERE id = ?").bind(id),
  ];
};
const accepted = ({
  input,
  id,
  current,
}: Readonly<{ input: MediaAdmissionInput; id: string; current: number }>): Effect.Effect<
  Response,
  MediaUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const rows = yield* io(() =>
      input.db.batch([
        ...prepareAuthorizedQuotaRead({
          db: input.db,
          userId: input.userId,
          current,
          authority: authorityFor(input),
        }),
      ])
    );
    const status = decodeQuotaStatus({ row: rows[1]?.results[0], current });
    if (Option.isNone(status)) return failure("unavailable", HTTP_UNAVAILABLE);
    const allowance = yield* Schema.encodeEffect(Schema.toCodecJson(AllowanceMeter))(
      status.value.mediaSubmissions
    );
    return Response.json(
      {
        data: {
          submissionId: id,
          status: "needs-review",
          reason: "extraction-unavailable",
          allowance,
        },
        next: [],
      },
      { status: HTTP_ACCEPTED, headers: noStore }
    );
  });
const refusal = (cause: unknown, current: number): Response => {
  const kind = quotaFailure(cause);
  if (kind === "exhausted") {
    return Response.json(
      {
        error: {
          code: "quota_exhausted",
          message: "Your Free receipt/screenshot allowance is exhausted.",
          allowance: "media_submission",
          resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
        },
        next: [],
      },
      { status: HTTP_LIMITED, headers: noStore }
    );
  }
  if (kind === "authority" || /media_publication_required/u.test(String(cause))) {
    return failure("user_action_required", HTTP_FORBIDDEN);
  }
  if (/media_work_capacity/u.test(String(cause))) {
    return new Response(failure("rate_limited", HTTP_LIMITED).body, {
      status: HTTP_LIMITED,
      headers: { ...noStore, "retry-after": "1" },
    });
  }
  return failure("unavailable", HTTP_UNAVAILABLE);
};
/** Publication, independent consumption, accountability, visible review and outbox identity commit together. No bytes or provider work are accepted on refusal. */
const replayMedia = ({
  input,
  id,
  current,
  inputDigest,
  stored,
}: MediaPublication & Readonly<{ stored: typeof StoredMedia.Type }>): Effect.Effect<
  Response,
  MediaUnavailable | Schema.SchemaError
> =>
  stored.input_digest === inputDigest
    ? accepted({ input, id, current })
    : Effect.succeed(failure("validation_failed", HTTP_CONFLICT));

const mediaDigest = ({
  mediaId,
  caption,
}: Readonly<{ mediaId: string; caption: string }>): Effect.Effect<string, MediaUnavailable> =>
  io(() =>
    crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify([mediaId, caption])))
      .then((buffer) =>
        Array.from(new Uint8Array(buffer), (byte) =>
          byte.toString(hexadecimalRadix).padStart(2, "0")
        ).join("")
      )
  );

/** Publication, independent consumption, accountability, visible review and outbox identity commit together. No bytes or provider work are accepted on refusal. */
export const admitMedia = (input: MediaAdmissionInput): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { event } = input;
    if (event.content._tag !== "Image") return failure("validation_failed", HTTP_BAD_REQUEST);
    const mediaId = event.content.mediaId;
    const caption = Option.getOrElse(event.content.caption, () => "");
    const inputDigest = yield* mediaDigest({ mediaId, caption });
    const existing = yield* findMedia(input);
    const current = Math.max(
      DateTime.toEpochMillis(event.receivedAt),
      yield* Clock.currentTimeMillis
    );
    if (Option.isSome(existing)) {
      return yield* replayMedia({
        input,
        id: existing.value.id,
        current,
        mediaId,
        caption,
        stored: existing.value,
        inputDigest,
      });
    }
    const id = newId();
    const result = yield* io(() =>
      input.db.batch([...publication({ input, id, current, mediaId, caption, inputDigest })])
    ).pipe(Effect.result);
    if (result._tag === "Success") return yield* accepted({ input, id, current });
    const raced = yield* findMedia(input);
    if (Option.isSome(raced)) {
      return yield* replayMedia({
        input,
        id: raced.value.id,
        current,
        mediaId,
        caption,
        stored: raced.value,
        inputDigest,
      });
    }
    return refusal(result.failure.cause, current);
  }).pipe(
    Effect.catchCause(() => Effect.succeed(failure("unavailable", HTTP_UNAVAILABLE))),
    Effect.withSpan("ingestion.mediaPublication")
  );
