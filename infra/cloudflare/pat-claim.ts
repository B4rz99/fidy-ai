import {
  ClaimPATPairingPayload,
  PAT,
  PATPairingDeviceCode,
  PATPairingId,
  claimPairingGrant,
  decidePATPairingClaim,
  insertClaimedPAT,
  recordPendingPoll,
  recordWrongPairingProof,
  slowPairingPoll,
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
  newBearer,
  newId,
  newShortId,
  patFrom,
  response,
  scopesFrom,
  unavailable,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";

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
  await prepareOwnedStatement(
    db,
    recordWrongPairingProof({
      attempts,
      pairingId: pairing.id,
      state: pairing.state,
      previous: pairing.wrong_attempts,
    })
  ).run();
  return invalid();
};
const slowPoll = async (
  db: D1Database,
  input: Readonly<{ pairing: typeof PairingRow.Type; seconds: number; retryAfter: number }>
): Promise<Response> => {
  const { pairing, seconds, retryAfter } = input;
  await prepareOwnedStatement(
    db,
    slowPairingPoll({
      seconds: Math.min(maximumPollSeconds, seconds),
      pairingId: pairing.id,
      state: pairing.state,
    })
  ).run();
  return response({ error: { code: "rate_limited", retryAfterSeconds: retryAfter } }, slowStatus);
};
const pending = async (
  db: D1Database,
  pairing: typeof PairingRow.Type,
  current: number
): Promise<Response> => {
  const result = await prepareOwnedStatement(
    db,
    recordPendingPoll({
      current,
      pairingId: pairing.id,
      lastPoll: Option.fromNullishOr(pairing.last_poll_at_ms),
    })
  ).run();
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
  pairing: typeof PairingRow.Type & Readonly<{ user_id: string; approved_at_ms: number }>;
  current: number;
  shortId: string;
  bearer: string;
  patId: string;
  expires: number;
}>;
const reserveClaim = async (db: D1Database, claim: Claim): Promise<boolean> => {
  const { pairing, current, shortId, bearer, patId, expires } = claim;
  const results = await commitPATUnit(db, [
    prepareOwnedStatement(
      db,
      claimPairingGrant({ pairingId: pairing.id, userId: pairing.user_id, current })
    ),
    prepareOwnedStatement(
      db,
      insertClaimedPAT({
        patId,
        shortId,
        bearerDigest: await digest(bearer),
        approvedAt: pairing.approved_at_ms,
        current,
        expires,
        pairingId: pairing.id,
        userId: pairing.user_id,
      })
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
    if (
      !(await reserveClaim(db, {
        pairing: { ...pairing, user_id: pairing.user_id, approved_at_ms: pairing.approved_at_ms },
        current,
        shortId,
        bearer,
        patId,
        expires,
      }))
    ) {
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
