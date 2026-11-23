import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import { UserId } from "../../../src/core/identity/contract";
import { PAT, PATPairingId } from "../../../src/core/tokens/contract";
import { decidePATPairingClaim } from "../../../src/core/tokens/operations";
import { claimPairingGrant, insertClaimedPAT } from "../../../src/shell/tokens/operations";
import { recordClaimedPAT } from "../../../src/shell/audit/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { type Directory, Reservation, directoryEvidence } from "./native-routes";
import { digest, invalid, iso, newBearer, patFrom, response, unavailable } from "./pat-shared";
import { decodeRequestPayload } from "./request-body";
import { PATUnavailable } from "../contract";

const isResponse = Schema.is(Schema.instanceOf(Response));

const claimResponse = Effect.fn(function* ({
  pairing,
  patId,
  shortId,
  bearer,
}: {
  pairing: Claimable;
  patId: string;
  shortId: string;
  bearer: string;
}) {
  const pat = yield* Effect.fromOption(
    patFrom({
      ...pairing,
      id: patId,
      short_id: shortId,
      created_at_ms: pairing.approved_at_ms,
      expires_at_ms: pairing.pat_expires_at_ms,
      last_used_at_ms: null,
      revoked_at_ms: null,
    })
  );

  return response({
    status: 200,
    body: { bearer, pat: yield* Schema.encodeEffect(Schema.toCodecJson(PAT))(pat) },
  });
});

const Claim = Schema.Struct({
  id: PATPairingId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});

const Pairing = Schema.Struct({
  id: PATPairingId,
  user_id: UserId,
  proof_matches: Schema.Literals([0, 1]),
  state: Schema.Literals([
    "pending_approval",
    "approved_awaiting_claim",
    "claimed",
    "expired_unapproved",
    "revoked_unclaimed",
  ]),
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
  approved_at_ms: Schema.NullOr(Schema.Int),
  pat_expires_at_ms: Schema.NullOr(Schema.Int),
  lifetime_days: Schema.Int,
  scopes_json: Schema.String,
  recipient_label: Schema.String,
});

const maximumPollSeconds = 60;

const applyDecision = Effect.fn(function* ({
  decision,
  pairing,
  id,
  current,
}: {
  decision: Effect.Success<ReturnType<typeof decidePATPairingClaim>>;
  pairing: typeof Pairing.Type;
  id: string;
  current: number;
}) {
  const sql = yield* SqliteClient;

  if (Predicate.isTagged(decision, "WrongProof")) {
    yield* sql`UPDATE pat_pairings SET wrong_attempts=${decision.wrongProofAttempts} WHERE id=${id} AND wrong_attempts=${pairing.wrong_attempts}`;

    return invalid();
  }

  if (Predicate.isTagged(decision, "SlowDown")) {
    yield* sql`UPDATE pat_pairings SET minimum_poll_seconds=${Math.min(maximumPollSeconds, decision.minimumPollIntervalSeconds)} WHERE id=${id} AND minimum_poll_seconds=${pairing.minimum_poll_seconds}`;

    return response({
      status: 429,
      body: { error: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds } },
    });
  }

  if (Predicate.isTagged(decision, "Pending")) {
    yield* sql`UPDATE pat_pairings SET last_poll_at_ms=${current} WHERE id=${id} AND last_poll_at_ms IS ${pairing.last_poll_at_ms}`;

    return response({
      status: 202,
      body: {
        status: "pending_approval",
        expiresAt: iso(pairing.expires_at_ms),
        pollingIntervalSeconds: pairing.minimum_poll_seconds,
      },
    });
  }

  if (
    !Predicate.isTagged(decision, "Claim") ||
    pairing.approved_at_ms === null ||
    pairing.pat_expires_at_ms === null
  ) {
    return invalid();
  }

  return {
    ...pairing,
    approved_at_ms: pairing.approved_at_ms,
    pat_expires_at_ms: pairing.pat_expires_at_ms,
  };
});

const observe = Effect.fn(function* (
  id: string,
  proof: Uint8Array,
  owns: (user: string) => boolean
) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`SELECT *,proof_digest=${proof} AS proof_matches FROM pat_pairings pairing WHERE id=${id} AND NOT EXISTS(SELECT 1 FROM erasure_requests e WHERE e.user_id=pairing.user_id)`;

  if (row === undefined) return invalid();
  const pairing = yield* Schema.decodeUnknownEffect(Pairing)(row);

  if (!owns(pairing.user_id)) return invalid();

  const decision = yield* decidePATPairingClaim({
    lifecycle: pairing.state,
    proofMatches: pairing.proof_matches === 1,
    wrongProofAttempts: pairing.wrong_attempts,
    minimumPollIntervalSeconds: pairing.minimum_poll_seconds,
    lastAcceptedPollAt: Option.map(
      Option.fromNullishOr(pairing.last_poll_at_ms),
      DateTime.makeUnsafe
    ),
    expiresAt: DateTime.makeUnsafe(pairing.expires_at_ms),
    attemptedAt: DateTime.makeUnsafe(current),
  });

  return yield* applyDecision({ decision, pairing, id, current });
});

type Claimable = Exclude<Effect.Success<ReturnType<typeof observe>>, Response>;

const issueClaim = Effect.fn(function* ({
  patId,
  shortId,
  bearerDigest,
  current,
  pairing,
}: {
  patId: string;
  shortId: string;
  bearerDigest: Uint8Array;
  current: number;
  pairing: Claimable;
}) {
  const sql = yield* SqliteClient;

  const issue = insertClaimedPAT({
    patId,
    shortId,
    bearerDigest,
    recipientLabel: pairing.recipient_label,
    scopesJson: pairing.scopes_json,
    lifetimeDays: pairing.lifetime_days,
    approvedAt: pairing.approved_at_ms,
    current,
    expires: pairing.pat_expires_at_ms,
    pairingId: pairing.id,
    userId: pairing.user_id,
  });

  const audit = recordClaimedPAT({ id: newId(), userId: pairing.user_id, patId, current });

  yield* Effect.forEach(
    [issue, audit],
    (statement) =>
      sql
        .unsafe(statement.sql + " RETURNING id", statement.params)
        .pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.fail(new PATUnavailable({ cause: Option.none() }))
              : Effect.void
          )
        ),
    { discard: true }
  );
});

export const localClaim = Effect.fn(
  function* (request: Request, directory: Directory, owns: (user: string) => boolean) {
    const requestProof = yield* decodeRequestPayload({ request, schema: Claim });

    if (Option.isNone(requestProof)) return invalid();
    const input = requestProof.value;
    const proof = yield* Effect.fromResult(Hex.decode(input.digest));
    const first = yield* observe(input.id, proof, owns).pipe(withStoreCapacity("required"));

    if (isResponse(first)) return first;

    const route = yield* directoryEvidence(
      directory,
      {
        kind: "reserve",
        user: first.user_id,
        operation: "pair:" + input.id,
        context: input.digest,
        expires: first.pat_expires_at_ms,
      },
      Reservation
    );

    if (Option.isNone(route) || route.value.expires_at_ms !== first.pat_expires_at_ms) {
      return unavailable();
    }

    const { short_id: shortId, pat_id: patId } = route.value;
    const bearer = newBearer(shortId);
    const bearerDigest = yield* Effect.tryPromise(() => digest(bearer));
    const sql = yield* SqliteClient;

    return yield* Effect.gen(function* () {
      const pairing = yield* observe(input.id, proof, owns);

      if (isResponse(pairing)) return pairing;

      if (
        pairing.user_id !== first.user_id ||
        pairing.pat_expires_at_ms !== route.value.expires_at_ms
      ) {
        return invalid();
      }

      const current = yield* Clock.currentTimeMillis;

      const claim = claimPairingGrant({
        pairingId: input.id,
        userId: pairing.user_id,
        proofDigest: proof,
        current,
      });

      if ((yield* sql.unsafe(claim.sql + " RETURNING id", claim.params)).length === 0) {
        return invalid();
      }

      yield* issueClaim({ patId, shortId, bearerDigest, current, pairing });

      return yield* claimResponse({ pairing, patId, shortId, bearer });
    }).pipe(withStoreCapacity("growth"));
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(unavailable()))
);
