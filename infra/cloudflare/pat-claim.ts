import {
  ClaimPATPairingPayload,
  PAT,
  PATPairingDeviceCode,
  PATPairingId,
  decidePATPairingClaim,
} from "@fidy/server/tokens-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { PairingRow } from "./pat-pairing";
import {
  currentMillis,
  decodeBody,
  digest,
  equalsDigest,
  invalid,
  iso,
  issuanceWindowMilliseconds,
  maxActivePATs,
  maxIssuancesPerUserWindow,
  newBearer,
  newId,
  newShortId,
  patFrom,
  response,
  scopesFrom,
  unavailable,
} from "./pat-shared";

const maximumPollSeconds = 60;
const pendingStatus = 202;
const slowStatus = 429;
const Proof = Schema.Struct({ pairingId: PATPairingId, privateDeviceCode: PATPairingDeviceCode });
const decodeProof = async (request: Request): Promise<Option.Option<typeof Proof.Type>> => {
  const input = await decodeBody(request, ClaimPATPairingPayload);
  return Option.flatMap(input, (value) => Schema.decodeUnknownOption(Proof)(value));
};

const recordWrongProof = async (
  db: D1Database,
  pairing: typeof PairingRow.Type,
  attempts: number
): Promise<Response> => {
  await db
    .prepare(
      `UPDATE pat_pairings SET wrong_attempts = ? WHERE id = ? AND state = ? AND wrong_attempts = ?`
    )
    .bind(attempts, pairing.id, pairing.state, pairing.wrong_attempts)
    .run();
  return invalid();
};
const slowPoll = async (
  db: D1Database,
  input: Readonly<{ pairing: typeof PairingRow.Type; seconds: number; retryAfter: number }>
): Promise<Response> => {
  const { pairing, seconds, retryAfter } = input;
  await db
    .prepare(`UPDATE pat_pairings SET minimum_poll_seconds = ? WHERE id = ? AND state = ?`)
    .bind(Math.min(maximumPollSeconds, seconds), pairing.id, pairing.state)
    .run();
  return response({ error: { code: "rate_limited", retryAfterSeconds: retryAfter } }, slowStatus);
};
const pending = async (
  db: D1Database,
  pairing: typeof PairingRow.Type,
  current: number
): Promise<Response> => {
  const result = await db
    .prepare(`UPDATE pat_pairings SET last_poll_at_ms = ? WHERE id = ?
    AND state = 'pending_approval' AND last_poll_at_ms IS ? AND expires_at_ms > ?`)
    .bind(current, pairing.id, pairing.last_poll_at_ms, current)
    .run();
  return result.meta.changes === 1
    ? response(
        {
          status: "pending_approval",
          expiresAt: iso(pairing.expires_at_ms),
          pollingIntervalSeconds: pairing.minimum_poll_seconds,
        },
        pendingStatus
      )
    : invalid();
};
type Claim = Readonly<{
  pairing: typeof PairingRow.Type;
  current: number;
  shortId: string;
  bearer: string;
  patId: string;
  expires: number;
}>;
const reserveClaim = async (db: D1Database, claim: Claim): Promise<boolean> => {
  const { pairing, current, shortId, bearer, patId, expires } = claim;
  const results = await db.batch([
    db
      .prepare(`UPDATE pat_pairings SET state = 'claimed' WHERE id = ? AND state = 'approved_awaiting_claim'
        AND user_id = ? AND expires_at_ms > ?
        AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pat_pairings.user_id)
        AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
        AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`)
      .bind(
        pairing.id,
        pairing.user_id,
        current,
        pairing.user_id,
        current,
        maxActivePATs,
        pairing.user_id,
        current - issuanceWindowMilliseconds,
        maxIssuancesPerUserWindow
      ),
    db
      .prepare(`INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
        created_at_ms,issued_at_ms,expires_at_ms,pairing_id)
        SELECT ?,user_id,?,?,recipient_label,scopes_json,lifetime_days,?,?,?,id
        FROM pat_pairings WHERE id = ? AND state = 'claimed' AND user_id = ? AND changes() = 1`)
      .bind(
        patId,
        shortId,
        await digest(bearer),
        pairing.approved_at_ms,
        current,
        expires,
        pairing.id,
        pairing.user_id
      ),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?, 'pats.claim', 'accepted', ? WHERE changes() = 1`)
      .bind(newId(), pairing.user_id, patId, current),
  ]);
  return results.every((item) => item.meta.changes === 1);
};
/** Atomically consume a reviewed private proof and mint one unrecoverable bearer. */
const mint = async (
  db: D1Database,
  pairing: typeof PairingRow.Type,
  current: number
): Promise<Response> => {
  if (
    pairing.user_id === null ||
    pairing.approved_at_ms === null ||
    pairing.pat_expires_at_ms === null
  ) {
    return invalid();
  }
  const scopes = scopesFrom(pairing.scopes_json);
  if (Option.isNone(scopes)) return unavailable();
  const shortId = newShortId();
  const bearer = newBearer(shortId);
  const patId = newId();
  const expires = pairing.pat_expires_at_ms;
  try {
    if (!(await reserveClaim(db, { pairing, current, shortId, bearer, patId, expires }))) {
      return invalid();
    }
    const pat = patFrom({
      id: patId,
      user_id: pairing.user_id,
      short_id: shortId,
      recipient_label: pairing.recipient_label,
      scopes_json: pairing.scopes_json,
      lifetime_days: pairing.lifetime_days,
      created_at_ms: pairing.approved_at_ms,
      expires_at_ms: expires,
      last_used_at_ms: null,
      revoked_at_ms: null,
    });
    return Option.isSome(pat)
      ? response({ pat: Schema.encodeSync(Schema.toCodecJson(PAT))(pat.value), bearer })
      : unavailable();
  } catch {
    return invalid();
  }
};
/** Only the original private-code holder may poll or claim; all terminal states refuse replay. */
export const claimPATPairing = async (request: Request, db: D1Database): Promise<Response> => {
  const proof = await decodeProof(request);
  if (Option.isNone(proof)) return invalid();
  const raw = await db
    .prepare(`SELECT * FROM pat_pairings WHERE id = ?`)
    .bind(proof.value.pairingId)
    .first();
  const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
  if (Option.isNone(pairing)) return invalid();
  const current = currentMillis();
  const decision = Effect.runSync(
    decidePATPairingClaim({
      lifecycle: pairing.value.state,
      proofMatches: equalsDigest(
        pairing.value.proof_digest,
        await digest(proof.value.privateDeviceCode)
      ),
      wrongProofAttempts: pairing.value.wrong_attempts,
      minimumPollIntervalSeconds: pairing.value.minimum_poll_seconds,
      lastAcceptedPollAt: Option.map(
        Option.fromNullishOr(pairing.value.last_poll_at_ms),
        DateTime.makeUnsafe
      ),
      expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
      attemptedAt: DateTime.makeUnsafe(current),
    })
  );
  if (decision._tag === "WrongProof") {
    return recordWrongProof(db, pairing.value, decision.wrongProofAttempts);
  }
  if (decision._tag === "SlowDown") {
    return slowPoll(db, {
      pairing: pairing.value,
      seconds: decision.minimumPollIntervalSeconds,
      retryAfter: decision.retryAfterSeconds,
    });
  }
  if (decision._tag === "Pending") return pending(db, pairing.value, current);
  if (decision._tag !== "Claim") return invalid();
  return mint(db, pairing.value, current);
};
