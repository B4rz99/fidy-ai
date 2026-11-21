import { PATUnavailable, localPATClaimUrl } from "../contract";
import { UserId } from "../../../src/core/identity/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  PATPairingDeviceCode,
  PATPairingId,
  StartPATPairingPayload,
} from "../../../src/core/tokens/contract";
import { decidePATPairingClaim, pairingWrongProofLimit } from "../../../src/core/tokens/operations";
import { maxPairingsPerWindow } from "../../../src/shell/tokens/operations";
import { newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  decodeBody,
  digest,
  invalid,
  iso,
  newProof,
  pairingMilliseconds,
  response,
  unavailable,
} from "./pat-shared";
import { publicCode, rateLimited } from "./pat-pairing";

const isResponse = Schema.is(Schema.instanceOf(Response));

const sourceLimit = 20;

const pollLimit = 60;

const initialPollSeconds = 5;

const success = 200;

const pending = 202;

const tooFast = 429;

const proofSchema = Schema.Struct({
  pairingId: PATPairingId,
  privateDeviceCode: PATPairingDeviceCode,
});

const start = Effect.fn(function* (request: Request) {
  const payload = yield* decodeBody({ request, schema: StartPATPairingPayload });

  if (Option.isNone(payload)) return invalid();
  const source = request.headers.get("x-pat-source") ?? "";

  if (!/^[a-f0-9]{64}$/u.test(source)) return unavailable();
  const sql = yield* SqliteClient;
  const code = publicCode();
  const privateCode = newProof();
  const proofDigest = Hex.encode(yield* Effect.tryPromise(() => digest(privateCode)));

  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const id = newId();
    const expires = current + pairingMilliseconds;
    const grant = payload.value;

    const admitted = yield* sql`INSERT INTO pat_source_windows(source,ends,used)
      SELECT ${source},${expires},1 WHERE (SELECT count(*) FROM pat_bootstrap WHERE expires_at_ms>${current})<${maxPairingsPerWindow}
      ON CONFLICT(source) DO UPDATE SET ends=CASE WHEN ends<=${current} THEN excluded.ends ELSE ends END,
      used=CASE WHEN ends<=${current} THEN 1 ELSE used+1 END WHERE ends<=${current} OR used<${sourceLimit} RETURNING used`;

    if (admitted.length === 0) return rateLimited();

    const inserted =
      yield* sql`INSERT INTO pat_bootstrap(id,public_code,proof_digest,recipient_label,scopes_json,lifetime_days,expires_at_ms)
      SELECT ${id},${code},${proofDigest},${grant.recipientLabel},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([...grant.scopes])},${grant.lifetimeDays},${expires} RETURNING id`;

    if (inserted.length !== 1) return yield* new PATUnavailable({ cause: Option.none() });

    return response({
      status: success,
      body: {
        pairingId: id,
        privateDeviceCode: privateCode,
        publicCode: code,
        expiresAt: iso(expires),
        pollingIntervalSeconds: initialPollSeconds,
      },
    });
  }).pipe(withStoreCapacity("growth"));
});

const Poll = Schema.Struct({
  proof_matches: Schema.Literals([0, 1]),
  wrong_attempts: Schema.Int,
  minimum_poll_seconds: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Int),
  expires_at_ms: Schema.Int,
});

const pollingDestination = Effect.fn(function* (id: string, proofDigest: string) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    const [bound] =
      yield* sql`SELECT user_id FROM pat_bootstrap WHERE id=${id} AND expires_at_ms>${current} AND user_id IS NOT NULL`;

    if (bound !== undefined) {
      return yield* Schema.decodeUnknownEffect(Schema.Struct({ user_id: UserId }))(bound);
    }

    const [row] =
      yield* sql`SELECT proof_digest=${proofDigest} AS proof_matches,wrong_attempts,minimum_poll_seconds,last_poll_at_ms,expires_at_ms FROM pat_bootstrap WHERE id=${id} AND user_id IS NULL`;

    if (row === undefined) return invalid();
    const value = yield* Schema.decodeUnknownEffect(Poll)(row);

    const decision = yield* decidePATPairingClaim({
      lifecycle: "pending_approval",
      proofMatches: value.proof_matches === 1,
      wrongProofAttempts: value.wrong_attempts,
      minimumPollIntervalSeconds: value.minimum_poll_seconds,
      lastAcceptedPollAt: Option.map(
        Option.fromNullishOr(value.last_poll_at_ms),
        DateTime.makeUnsafe
      ),
      expiresAt: DateTime.makeUnsafe(value.expires_at_ms),
      attemptedAt: DateTime.makeUnsafe(current),
    });

    if (Predicate.isTagged(decision, "WrongProof")) {
      if (decision.wrongProofAttempts >= pairingWrongProofLimit) {
        yield* sql`DELETE FROM pat_bootstrap WHERE id=${id} AND user_id IS NULL`;

        return invalid();
      }

      yield* sql`UPDATE pat_bootstrap SET wrong_attempts=${decision.wrongProofAttempts} WHERE id=${id}`;

      return invalid();
    }

    if (Predicate.isTagged(decision, "SlowDown")) {
      yield* sql`UPDATE pat_bootstrap SET minimum_poll_seconds=${Math.min(pollLimit, decision.minimumPollIntervalSeconds)} WHERE id=${id}`;

      return response({
        status: tooFast,
        body: { error: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds } },
      });
    }

    if (!Predicate.isTagged(decision, "Pending")) return invalid();
    yield* sql`UPDATE pat_bootstrap SET last_poll_at_ms=${current} WHERE id=${id}`;

    return response({
      status: pending,
      body: {
        status: "pending_approval",
        expiresAt: iso(value.expires_at_ms),
        pollingIntervalSeconds: value.minimum_poll_seconds,
      },
    });
  }).pipe(withStoreCapacity("required"));
});

const poll = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const proof = yield* decodeBody({ request, schema: proofSchema });

  if (Option.isNone(proof)) return invalid();
  const id = proof.value.pairingId;

  const proofDigest = Hex.encode(
    yield* Effect.tryPromise(() => digest(proof.value.privateDeviceCode))
  );

  const destination = yield* pollingDestination(id, proofDigest);

  if (isResponse(destination)) return destination;

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
    id,
    digest: proofDigest,
  });

  return yield* Effect.tryPromise((signal) =>
    users.getByName(destination.user_id).fetch(localPATClaimUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );
});

export const nativePairing = ({
  request,
  users,
}: {
  request: Request;
  users: Pick<DurableObjectNamespace, "getByName">;
}): ReturnType<typeof poll> | ReturnType<typeof start> =>
  new URL(request.url).pathname === "/pat-pairings" ? start(request) : poll(request, users);
