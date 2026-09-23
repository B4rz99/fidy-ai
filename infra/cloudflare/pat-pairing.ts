import {
  ApprovePATPairingPayload,
  PATPairingPublicCodeInput,
  PATPairingReview,
  StartPATPairingPayload,
  buildPairedPATDisclosure,
  selectPATPairingPublicCodeSymbols,
} from "@fidy/server/tokens-runtime";
import { DateTime, Option, Schema } from "effect";
import {
  canonical,
  currentMillis,
  dayMilliseconds,
  decodeBody,
  digest,
  httpRateLimited,
  invalid,
  iso,
  newId,
  newProof,
  pairingMilliseconds,
  rejected,
  response,
  scopesFrom,
  sessionExists,
  sessionParams,
  unauthorized,
  unavailable,
  webSession,
} from "./pat-shared";

const symbolCount = 8;
const sampleBytes = 16;
// One source IP cannot exhaust this pool under the edge's 60-per-10-second budget.
const maxPairingsPerWindow = 4000;
const maximumReviewAttempts = 10;
const reviewRetrySeconds = 60;
const rateLimited = (): Response =>
  response(
    {
      error: {
        code: "rate_limited",
        message: "This PAT pairing is invalid or no longer available. Start a new request.",
        retryAfterSeconds: reviewRetrySeconds,
      },
      next: [],
    },
    httpRateLimited
  );
const publicCode = (): string => {
  let symbols = "";
  while (symbols.length < symbolCount) {
    symbols += selectPATPairingPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(sampleBytes))),
      maximum: symbolCount - symbols.length,
    });
  }
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
export const PairingRow = Schema.Struct({
  id: Schema.String,
  proof_digest: Schema.Array(Schema.Int),
  public_code: Schema.String,
  recipient_label: Schema.String,
  scopes_json: Schema.String,
  lifetime_days: Schema.Int,
  created_at_ms: Schema.Finite,
  expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "pending_approval",
    "approved_awaiting_claim",
    "claimed",
    "expired_unapproved",
    "revoked_unclaimed",
  ]),
  user_id: Schema.NullOr(Schema.String),
  approved_at_ms: Schema.NullOr(Schema.Finite),
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_seconds: Schema.Int,
});
export type PairingRow = typeof PairingRow.Type;

/** Bound anonymous creation before allocating a new pairing or storing its digest. */
export const startPATPairing = async (request: Request, db: D1Database): Promise<Response> => {
  const payload = await decodeBody(request, StartPATPairingPayload);
  if (Option.isNone(payload)) return invalid();
  const current = currentMillis();
  const code = publicCode();
  const privateCode = newProof();
  const pairingId = newId();
  const expires = current + pairingMilliseconds;
  try {
    const inserted = await db
      .prepare(`INSERT INTO pat_pairings
      (id,public_code,proof_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,expires_at_ms)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM pat_pairings WHERE created_at_ms > ?) < ?`)
      .bind(
        pairingId,
        code,
        await digest(privateCode),
        payload.value.recipientLabel,
        JSON.stringify(payload.value.scopes),
        payload.value.lifetimeDays,
        current,
        expires,
        current - pairingMilliseconds,
        maxPairingsPerWindow
      )
      .run();
    if (inserted.meta.changes !== 1) return rateLimited();
    return response({
      pairingId,
      privateDeviceCode: privateCode,
      publicCode: code,
      expiresAt: iso(expires),
      pollingIntervalSeconds: 5,
    });
  } catch {
    return unavailable();
  }
};

const admitReview = async (
  db: D1Database,
  sessionId: string,
  current: number
): Promise<boolean> => {
  const result = await db
    .prepare(`INSERT INTO pat_review_attempts (id,session_id,occurred_at_ms)
    SELECT ?,?,? WHERE (SELECT count(*) FROM pat_review_attempts WHERE session_id = ? AND occurred_at_ms > ?) < ?`)
    .bind(
      newId(),
      sessionId,
      current,
      sessionId,
      current - pairingMilliseconds,
      maximumReviewAttempts
    )
    .run();
  return result.meta.changes === 1;
};
/** Inspect a public code only for a fresh browser User, with bounded guessing. */
export const inspectPATPairing = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  const current = currentMillis();
  if (!(await admitReview(db, session.value.id, current))) return rateLimited();
  const input = await decodeBody(request, Schema.Struct({ publicCode: Schema.String }));
  const code = Option.flatMap(input, (value) =>
    Schema.decodeOption(PATPairingPublicCodeInput)(value.publicCode)
  );
  if (Option.isNone(code)) return rejected();
  const raw = await db
    .prepare(`SELECT * FROM pat_pairings WHERE public_code = ? AND state = 'pending_approval'
    AND expires_at_ms > ?`)
    .bind(code.value, current)
    .first();
  const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
  if (Option.isNone(pairing)) return rejected();
  const scopes = scopesFrom(pairing.value.scopes_json);
  if (Option.isNone(scopes)) return unavailable();
  const review = Schema.decodeUnknownOption(Schema.toType(PATPairingReview))({
    pairingId: pairing.value.id,
    recipientLabel: pairing.value.recipient_label,
    scopes: scopes.value,
    lifetimeDays: pairing.value.lifetime_days,
    patExpiresAt: DateTime.makeUnsafe(
      pairing.value.created_at_ms + pairing.value.lifetime_days * dayMilliseconds
    ),
    claimBy: DateTime.makeUnsafe(pairing.value.expires_at_ms),
  });
  return Option.isSome(review)
    ? canonical(Schema.encodeSync(Schema.toCodecJson(PATPairingReview))(review.value))
    : unavailable();
};

/** Approve one reviewed immutable grant and append its exact User-bound disclosure atomically. */
export const approvePATPairing = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  const payload = await decodeBody(request, Schema.toCodecJson(ApprovePATPairingPayload));
  if (Option.isNone(payload)) return rejected();
  const current = currentMillis();
  const raw = await db
    .prepare(`SELECT * FROM pat_pairings WHERE id = ? AND state = 'pending_approval'
    AND expires_at_ms > ?`)
    .bind(payload.value.pairingId, current)
    .first();
  const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
  if (Option.isNone(pairing)) return rejected();
  const expires = pairing.value.created_at_ms + pairing.value.lifetime_days * dayMilliseconds;
  if (DateTime.toEpochMillis(payload.value.patExpiresAt) !== expires) return rejected();
  const scopes = scopesFrom(pairing.value.scopes_json);
  if (Option.isNone(scopes)) return unavailable();
  const disclosure = buildPairedPATDisclosure({
    grant: {
      recipientLabel: Schema.decodeSync(StartPATPairingPayload.fields.recipientLabel)(
        pairing.value.recipient_label
      ),
      scopes: scopes.value,
      lifetimeDays: Schema.decodeUnknownSync(StartPATPairingPayload.fields.lifetimeDays)(
        pairing.value.lifetime_days
      ),
    },
    expiresAt: payload.value.patExpiresAt,
  });
  const committed = await db.batch([
    db
      .prepare(`UPDATE pat_pairings SET state = 'approved_awaiting_claim', user_id = ?, approved_at_ms = ?
      WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND ${sessionExists}`)
      .bind(
        session.value.user_id,
        current,
        pairing.value.id,
        current,
        ...sessionParams(session.value, current)
      ),
    db
      .prepare(`INSERT INTO pat_grant_consents (id,user_id,session_id,pairing_id,disclosure_revision,disclosure_text,accepted_at_ms)
      SELECT ?,?,?,?,'pat-pairing-grant-2026-09',?,? WHERE changes() = 1`)
      .bind(
        newId(),
        session.value.user_id,
        session.value.id,
        pairing.value.id,
        disclosure,
        current
      ),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?,'pats.approvePATPairing','accepted',? WHERE changes() = 1`)
      .bind(newId(), session.value.user_id, session.value.id, current),
  ]);
  if (committed.some((item) => item.meta.changes !== 1)) return rejected();
  return canonical({ pairingId: pairing.value.id, claimBy: iso(pairing.value.expires_at_ms) });
};
