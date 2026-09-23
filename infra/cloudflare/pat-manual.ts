import {
  CreateManualPATPayload,
  ManualPATIssuanceConsumed,
  ManualPATReviewExpired,
  PAT,
  buildPATDisclosure,
  issuanceConsumedMessage,
  reviewExpiredMessage,
} from "@fidy/server/tokens-runtime";
import { DateTime, Option, Schema } from "effect";
import {
  type SessionRow,
  canonical,
  currentMillis,
  dayMilliseconds,
  decodeBody,
  digest,
  httpBadRequest,
  httpConflict,
  httpReviewExpired,
  maxActivePATs,
  newBearer,
  newId,
  newShortId,
  pairingMilliseconds,
  patFrom,
  response,
  sessionExists,
  sessionParams,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";

const invalidReview = (): Response =>
  response(
    { error: { code: "validation_failed", message: "Review the PAT grant again." }, next: [] },
    httpBadRequest
  );
const expiredReview = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ManualPATReviewExpired))(
      ManualPATReviewExpired.make({
        error: { code: "user_action_required", message: reviewExpiredMessage },
        next: [],
      })
    ),
    httpReviewExpired
  );
const consumed = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ManualPATIssuanceConsumed))(
      ManualPATIssuanceConsumed.make({
        error: { code: "user_action_required", message: issuanceConsumedMessage },
        next: [],
      })
    ),
    httpConflict
  );
type Issuance = Readonly<{
  input: typeof CreateManualPATPayload.Type;
  session: SessionRow;
  current: number;
  expires: number;
  patId: string;
  shortId: string;
  bearer: string;
}>;
/** Insert a grant, its exact disclosure and metadata-only audit as one D1 unit. */
const commitIssuance = async (db: D1Database, issue: Issuance): Promise<boolean> => {
  const { input, session, current, expires, patId, shortId, bearer } = issue;
  const { grant, requestId } = input;
  const disclosure = buildPATDisclosure({ grant, expiresAt: DateTime.makeUnsafe(expires) });
  const committed = await db.batch([
    db
      .prepare(`INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
      created_at_ms,expires_at_ms,request_id) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${sessionExists}
      AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?`)
      .bind(
        patId,
        session.user_id,
        shortId,
        await digest(bearer),
        grant.recipientLabel,
        JSON.stringify(grant.scopes),
        grant.lifetimeDays,
        current,
        expires,
        requestId,
        ...sessionParams(session, current),
        session.user_id,
        current,
        maxActivePATs
      ),
    db
      .prepare(`INSERT INTO pat_grant_consents (id,user_id,session_id,request_id,disclosure_revision,disclosure_text,accepted_at_ms)
      SELECT ?,?,?,?,'pat-grant-2026-09',?,? WHERE changes() = 1`)
      .bind(newId(), session.user_id, session.id, requestId, disclosure, current),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?,?,'pats.createManualPAT','accepted',? WHERE changes() = 1`)
      .bind(newId(), session.user_id, session.id, patId, current),
  ]);
  return committed.every((item) => item.meta.changes === 1);
};
const issuedResponse = (issue: Issuance): Response => {
  const { input, session, current, expires, patId, shortId, bearer } = issue;
  const pat = patFrom({
    id: patId,
    user_id: session.user_id,
    short_id: shortId,
    recipient_label: input.grant.recipientLabel,
    scopes_json: JSON.stringify(input.grant.scopes),
    lifetime_days: input.grant.lifetimeDays,
    created_at_ms: current,
    expires_at_ms: expires,
    last_used_at_ms: null,
    revoked_at_ms: null,
  });
  if (Option.isNone(pat)) return unavailable();
  const encoded = Schema.encodeSync(Schema.toCodecJson(PAT))(pat.value);
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    return unavailable();
  }
  return canonical({
    pat: { ...encoded, idleExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)) },
    bearer,
  });
};

const expiryFor = (
  grant: typeof CreateManualPATPayload.Type.grant,
  current: number
): Option.Option<number> => {
  const maximum = current + grant.lifetimeDays * dayMilliseconds;
  const expires =
    grant.reviewExpiresAt === undefined ? maximum : DateTime.toEpochMillis(grant.reviewExpiresAt);
  return expires > current && expires <= maximum && expires >= maximum - pairingMilliseconds
    ? Option.some(expires)
    : Option.none();
};
const failedIssuance = async (
  db: D1Database,
  requestId: string,
  userId: string
): Promise<Response> => {
  const prior = await db
    .prepare("SELECT 1 FROM pats WHERE request_id = ? AND user_id = ?")
    .bind(requestId, userId)
    .first();
  return prior === null ? unavailable() : consumed();
};

/** Issue one manually reviewed User-owned bearer; failed or repeated ids never reveal it again. */
export const createManualPAT = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  const input = await decodeBody(request, Schema.toCodecJson(CreateManualPATPayload));
  if (Option.isNone(input)) return invalidReview();
  const current = currentMillis();
  const expiry = expiryFor(input.value.grant, current);
  if (Option.isNone(expiry)) return expiredReview();
  const shortId = newShortId();
  const issue = {
    input: input.value,
    session: session.value,
    current,
    expires: expiry.value,
    shortId,
    patId: newId(),
    bearer: newBearer(shortId),
  };
  try {
    if (!(await commitIssuance(db, issue))) {
      return unavailable();
    }
    return issuedResponse(issue);
  } catch {
    return failedIssuance(db, input.value.requestId, session.value.user_id);
  }
};
