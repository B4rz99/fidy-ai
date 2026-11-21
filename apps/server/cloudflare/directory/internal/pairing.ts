import { drainBootstrapExpiry } from "./expiry";
import { proofPolicy } from "../../browser-login/contract";
import {
  digestVerifier,
  invalidPairing,
  sampleBrowserLoginPublicCode,
} from "../../browser-login/operations";
import { Clock, DateTime, Effect, Option, Predicate, Redacted, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { ProviderBrowserProof } from "../../../src/shell/provider-authentication/contract";
import {
  browserLoginPairingExpiry,
  decideBrowserLoginRedemption,
} from "../../../src/core/browser-login/operations";
import { newId, newSecret } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { boundedJsonBody } from "../../http/operations";
import { UserId } from "../../../src/core/identity/contract";

const isResponse = Schema.is(Schema.instanceOf(Response));

const maximumWrongProofs = 5;

const maximumPollSeconds = 60;

export const startPairing = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const privateVerifier = Redacted.value(yield* newSecret);
  const digest = yield* digestVerifier(privateVerifier);
  const pairingId = newId();
  const publicCode = sampleBrowserLoginPublicCode();

  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const expiry = browserLoginPairingExpiry(DateTime.makeUnsafe(current));
    yield* drainBootstrapExpiry(current);
    yield* sql`INSERT INTO browser_pairings(id,public_code,verifier_digest,expires_at_ms) VALUES(${pairingId},${publicCode},${digest},${DateTime.toEpochMillis(expiry)})`;

    return Response.json(
      {
        pairingId,
        privateVerifier,
        publicCode,
        expiresAt: DateTime.formatIso(expiry),
        pollingIntervalSeconds: 5,
      },
      { headers: { "cache-control": "no-store" } }
    );
  }).pipe(withStoreCapacity("growth"));
});

const Pairing = Schema.Struct({
  user_id: Schema.NullOr(UserId),
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  minimum_poll_seconds: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  matches: Schema.Int,
});

const inspectPairing = Effect.fn(function* (pairingId: string, digest: string) {
  const sql = yield* SqliteClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [raw] =
        yield* sql`SELECT user_id,expires_at_ms,wrong_attempts,minimum_poll_seconds,last_poll_ms,verifier_digest=${digest} AS matches FROM browser_pairings WHERE id=${pairingId}`;

      if (raw === undefined) return invalidPairing();
      const row = yield* Schema.decodeUnknownEffect(Pairing)(raw);

      if (row.user_id !== null) return row.user_id;

      const decision = decideBrowserLoginRedemption({
        lifecycle: row.wrong_attempts >= maximumWrongProofs ? "invalidated" : "pending_approval",
        verifierMatches: row.matches === 1,
        expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        wrongVerifierAttempts: row.wrong_attempts,
        minimumPollIntervalSeconds: row.minimum_poll_seconds,
        lastAcceptedPollAt: Option.map(Option.fromNullishOr(row.last_poll_ms), (ms) =>
          DateTime.makeUnsafe(ms)
        ),
      });

      if (Predicate.isTagged(decision, "WrongVerifier")) {
        yield* sql`UPDATE browser_pairings SET wrong_attempts=${decision.wrongVerifierAttempts} WHERE id=${pairingId} AND wrong_attempts=${row.wrong_attempts} AND user_id IS NULL`;
      }

      if (Predicate.isTagged(decision, "Pending")) {
        yield* sql`UPDATE browser_pairings SET last_poll_ms=${DateTime.toEpochMillis(decision.acceptedAt)} WHERE id=${pairingId} AND last_poll_ms IS ${row.last_poll_ms} AND user_id IS NULL`;

        return Response.json(
          {
            status: "pending_approval",
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expires_at_ms)),
            pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
          },
          { status: 202, headers: { "cache-control": "no-store" } }
        );
      }

      if (Predicate.isTagged(decision, "SlowDown")) {
        const retry = Math.min(maximumPollSeconds, decision.retryAfterSeconds);
        yield* sql`UPDATE browser_pairings SET minimum_poll_seconds=${Math.min(maximumPollSeconds, decision.minimumPollIntervalSeconds)} WHERE id=${pairingId} AND minimum_poll_seconds=${row.minimum_poll_seconds} AND user_id IS NULL`;

        return Response.json(
          { error: { code: "rate_limited", retryAfterSeconds: retry } },
          { status: 429, headers: { "retry-after": String(retry), "cache-control": "no-store" } }
        );
      }

      return invalidPairing();
    })
  );
});

export const pollPairing = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const proof = yield* boundedJsonBody({
    request,
    policy: proofPolicy,
    schema: ProviderBrowserProof,
  });

  if (Option.isNone(proof)) return invalidPairing();
  const { pairingId, privateVerifier } = proof.value;
  const digest = yield* digestVerifier(privateVerifier);
  const result = yield* inspectPairing(pairingId, digest);

  if (isResponse(result)) return result;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(proof.value);

  return yield* Effect.tryPromise((signal) =>
    users.getByName(result).fetch("https://user.invalid/browser/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );
});
