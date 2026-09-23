import {
  ClaimPATPairingPayload,
  PAT,
  PATPairingDeviceCode,
  PATPairingId,
  claimPairingGrant,
  decidePATPairingClaim,
  insertClaimedPAT,
  recordClaimedPAT,
  recordPendingPoll,
  recordWrongPairingProof,
  slowPairingPoll,
} from "@fidy/server/tokens-runtime";
import { type Cause, DateTime, Effect, Function, Option, Schema } from "effect";
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
const successStatus = 200;
const Proof = Schema.Struct({ pairingId: PATPairingId, privateDeviceCode: PATPairingDeviceCode });
const decodeProof = (
  request: Request
): Effect.Effect<Option.Option<typeof Proof.Type>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const input = yield* Effect.tryPromise(() => decodeBody(request, ClaimPATPairingPayload));
    return Option.flatMap(input, (value) => Schema.decodeUnknownOption(Proof)(value));
  });

const recordWrongProof = (
  db: D1Database,
  pairing: PairingRow,
  attempts: number
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      prepareOwnedStatement(
        db,
        recordWrongPairingProof({
          attempts,
          pairingId: pairing.id,
          state: pairing.state,
          previous: pairing.wrong_attempts,
        })
      ).run()
    );
    return invalid();
  });
const slowPoll = (
  db: D1Database,
  input: Readonly<{ pairing: PairingRow; seconds: number; retryAfter: number }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { pairing, seconds, retryAfter } = input;
    yield* Effect.tryPromise(() =>
      prepareOwnedStatement(
        db,
        slowPairingPoll({
          seconds: Math.min(maximumPollSeconds, seconds),
          pairingId: pairing.id,
          state: pairing.state,
        })
      ).run()
    );
    return response({ error: { code: "rate_limited", retryAfterSeconds: retryAfter } }, slowStatus);
  });
const pending = (
  db: D1Database,
  pairing: PairingRow,
  current: number
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      prepareOwnedStatement(
        db,
        recordPendingPoll({
          current,
          pairingId: pairing.id,
          lastPoll: Option.fromNullishOr(pairing.last_poll_at_ms),
        })
      ).run()
    );
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
  });
type Claim = Readonly<{
  pairing: PairingRow & Readonly<{ user_id: string; approved_at_ms: number }>;
  current: number;
  shortId: string;
  bearer: string;
  patId: string;
  expires: number;
}>;
const reserveClaim = (db: D1Database, claim: Claim): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { pairing, current, shortId, bearer, patId, expires } = claim;
    const bearerDigest = yield* Effect.tryPromise(() => digest(bearer));
    const results = yield* Effect.tryPromise(() =>
      commitPATUnit(db, [
        prepareOwnedStatement(
          db,
          claimPairingGrant({ pairingId: pairing.id, userId: pairing.user_id, current })
        ),
        prepareOwnedStatement(
          db,
          insertClaimedPAT({
            patId,
            shortId,
            bearerDigest,
            approvedAt: pairing.approved_at_ms,
            current,
            expires,
            pairingId: pairing.id,
            userId: pairing.user_id,
          })
        ),
        prepareOwnedStatement(
          db,
          recordClaimedPAT({ id: newId(), userId: pairing.user_id, patId, current })
        ),
      ])
    );
    return results.every((item) => item.meta.changes === 1);
  });
/** Atomically consume a reviewed private proof and mint one unrecoverable bearer. */
const mint = (
  db: D1Database,
  pairing: PairingRow,
  current: number
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (
      pairing.user_id === null ||
      pairing.approved_at_ms === null ||
      pairing.pat_expires_at_ms === null
    ) {
      return invalid();
    }
    const userId = pairing.user_id;
    const approvedAt = pairing.approved_at_ms;
    const scopes = scopesFrom(pairing.scopes_json);
    if (Option.isNone(scopes)) return unavailable();
    const shortId = newShortId();
    const bearer = newBearer(shortId);
    const patId = newId();
    const expires = pairing.pat_expires_at_ms;
    return yield* Effect.gen(function* () {
      if (
        !(yield* reserveClaim(db, {
          pairing: { ...pairing, user_id: userId, approved_at_ms: approvedAt },
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
        user_id: userId,
        short_id: shortId,
        recipient_label: pairing.recipient_label,
        scopes_json: pairing.scopes_json,
        lifetime_days: pairing.lifetime_days,
        created_at_ms: approvedAt,
        expires_at_ms: expires,
        last_used_at_ms: null,
        revoked_at_ms: null,
      });
      return Option.isSome(pat)
        ? response(
            { pat: yield* Schema.encodeEffect(Schema.toCodecJson(PAT))(pat.value), bearer },
            successStatus
          )
        : unavailable();
    }).pipe(Effect.orElseSucceed(() => invalid()));
  });
/** Only the original private-code holder may poll or claim; all terminal states refuse replay. */
export const claimPATPairing = Function.dual<
  (db: D1Database) => (request: Request) => Promise<Response>,
  (request: Request, db: D1Database) => Promise<Response>
>(2, (request, db) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const proof = yield* decodeProof(request);
      if (Option.isNone(proof)) return invalid();
      const raw = yield* Effect.tryPromise(() =>
        db.prepare(`SELECT * FROM pat_pairings WHERE id = ?`).bind(proof.value.pairingId).first()
      );
      const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
      if (Option.isNone(pairing)) return invalid();
      const current = currentMillis();
      const proofDigest = yield* Effect.tryPromise(() => digest(proof.value.privateDeviceCode));
      const decision = yield* decidePATPairingClaim({
        lifecycle: pairing.value.state,
        proofMatches: equalsDigest(pairing.value.proof_digest, proofDigest),
        wrongProofAttempts: pairing.value.wrong_attempts,
        minimumPollIntervalSeconds: pairing.value.minimum_poll_seconds,
        lastAcceptedPollAt: Option.map(
          Option.fromNullishOr(pairing.value.last_poll_at_ms),
          DateTime.makeUnsafe
        ),
        expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(current),
      });
      if (decision._tag === "WrongProof") {
        return yield* recordWrongProof(db, pairing.value, decision.wrongProofAttempts);
      }
      if (decision._tag === "SlowDown") {
        return yield* slowPoll(db, {
          pairing: pairing.value,
          seconds: decision.minimumPollIntervalSeconds,
          retryAfter: decision.retryAfterSeconds,
        });
      }
      if (decision._tag === "Pending") return yield* pending(db, pairing.value, current);
      if (decision._tag !== "Claim") return invalid();
      return yield* mint(db, pairing.value, current);
    })
  )
);
