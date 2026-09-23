import {
  ApprovePATPairingPayload,
  PATPairingPublicCodeInput,
  PATPairingReview,
  StartPATPairingPayload,
  admitPairingReview,
  admitPairingSource,
  approvePairingGrant,
  buildPairedPATDisclosure,
  expireApprovedPairings,
  expireFixedPATs,
  pairingExpiryCompletion,
  patExpiryCompletion,
  selectPATPairingPublicCodeSymbols,
  startPairingGrant,
  sweepPairingAdmission,
  sweepPairingReviews,
  sweepUnapprovedPairings,
} from "@fidy/server/tokens-runtime";
import { DateTime, Encoding, Option, Result, Schema } from "effect";
import {
  expirePATConsents,
  expirePairingConsents,
  grantPairedPATConsent,
} from "@fidy/server/consent-pat";
import {
  type SessionRow,
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
  unauthorized,
  unavailable,
  webSession,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";

const symbolCount = 8;
const sampleBytes = 16;
const scheduledSweepLimit = 4000;
const sourceDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
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
  pat_expires_at_ms: Schema.NullOr(Schema.Finite),
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_seconds: Schema.Int,
});
export type PairingRow = typeof PairingRow.Type;

/** Reclaim unapproved anonymous metadata; never remove approved User-bound grant evidence. */
export const sweepExpiredPATPairings = async (db: D1Database): Promise<void> => {
  const current = currentMillis();
  await db.batch([
    prepareOwnedStatement(db, expirePairingConsents(current, scheduledSweepLimit)),
    prepareOwnedStatement(db, expireApprovedPairings(current)),
    db.prepare(pairingExpiryCompletion).bind(current),
    prepareOwnedStatement(db, expirePATConsents(current, scheduledSweepLimit)),
    prepareOwnedStatement(db, expireFixedPATs(current)),
    db.prepare(patExpiryCompletion).bind(current),
    prepareOwnedStatement(db, sweepUnapprovedPairings(current, scheduledSweepLimit)),
    prepareOwnedStatement(db, sweepPairingAdmission(current, scheduledSweepLimit)),
    prepareOwnedStatement(db, sweepPairingReviews(current, scheduledSweepLimit)),
  ]);
};
type StartedPairing = Readonly<{
  source: Uint8Array;
  payload: typeof StartPATPairingPayload.Type;
  current: number;
  code: string;
  privateCode: string;
  pairingId: string;
  expires: number;
}>;
const reservePairing = async (db: D1Database, start: StartedPairing): Promise<boolean> => {
  const { source, payload, current, code, privateCode, pairingId, expires } = start;
  const committed = await db.batch([
    prepareOwnedStatement(db, sweepPairingAdmission(current, scheduledSweepLimit)),
    prepareOwnedStatement(db, admitPairingSource(source, current)),
    prepareOwnedStatement(
      db,
      startPairingGrant({
        id: pairingId,
        publicCode: code,
        proofDigest: await digest(privateCode),
        recipientLabel: payload.recipientLabel,
        scopes: payload.scopes,
        lifetimeDays: payload.lifetimeDays,
        current,
        expires,
      })
    ),
  ]);
  return committed[2]?.meta.changes === 1;
};
/** Bound anonymous creation before allocating a new pairing or storing its digest. */
export const startPATPairing = async (request: Request, db: D1Database): Promise<Response> => {
  const payload = await decodeBody(request, StartPATPairingPayload);
  if (Option.isNone(payload)) return invalid();
  const source = Schema.decodeUnknownOption(sourceDigest)(request.headers.get("x-pat-source"));
  if (Option.isNone(source)) return unavailable();
  const bytes = Encoding.decodeHex(source.value);
  if (Result.isFailure(bytes)) return unavailable();
  const current = currentMillis();
  const code = publicCode();
  const privateCode = newProof();
  const pairingId = newId();
  const expires = current + pairingMilliseconds;
  try {
    if (
      !(await reservePairing(db, {
        source: bytes.success,
        payload: payload.value,
        current,
        code,
        privateCode,
        pairingId,
        expires,
      }))
    ) {
      return rateLimited();
    }
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
  const result = await prepareOwnedStatement(
    db,
    admitPairingReview({
      id: newId(),
      sessionId,
      current,
    })
  ).run();
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
    claimBy: DateTime.makeUnsafe(pairing.value.expires_at_ms),
  });
  return Option.isSome(review)
    ? canonical(Schema.encodeSync(Schema.toCodecJson(PATPairingReview))(review.value))
    : unavailable();
};

type Approval = Readonly<{
  session: SessionRow;
  pairing: PairingRow;
  current: number;
  expires: number;
  disclosure: string;
}>;
const commitApproval = async (db: D1Database, approval: Approval): Promise<boolean> => {
  const { session, pairing, current, expires, disclosure } = approval;
  const committed = await commitPATUnit(db, [
    prepareOwnedStatement(
      db,
      approvePairingGrant(session, {
        pairingId: pairing.id,
        current,
        expires,
      })
    ),
    prepareOwnedStatement(
      db,
      grantPairedPATConsent(session, {
        id: newId(),
        pairingId: pairing.id,
        disclosure,
        current,
      })
    ),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?,'pats.approvePATPairing','accepted',? WHERE changes() = 1`)
      .bind(newId(), session.user_id, session.id, current),
  ]);
  return committed.every((item) => item.meta.changes === 1);
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
  const expires = current + pairing.value.lifetime_days * dayMilliseconds;
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
    expiresAt: DateTime.makeUnsafe(expires),
  });
  if (
    !(await commitApproval(db, {
      session: session.value,
      pairing: pairing.value,
      current,
      expires,
      disclosure,
    }))
  ) {
    return rejected();
  }
  return canonical({
    pairingId: pairing.value.id,
    patExpiresAt: iso(expires),
    claimBy: iso(pairing.value.expires_at_ms),
  });
};
