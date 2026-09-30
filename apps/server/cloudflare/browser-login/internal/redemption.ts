import { Clock, DateTime, Effect, Option } from "effect";
import {
  decideBrowserLoginRedemption,
  maximumWrongVerifierAttempts,
} from "../../../src/core/browser-login/operations";
import { prepareWebSessionIssuance } from "@fidy/server/web-session-runtime";
import {
  type Pairing,
  type Proof,
  digest,
  maximumPollSeconds,
  recordWrongVerifier,
  sameDigest,
} from "./pairing-proof";

const httpPending = 202;
const httpLimited = 429;
const httpInvalid = 400;
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const json = (body: object, status: number, headers?: HeadersInit): Response => {
  const selected = new Headers(headers);
  selected.set("cache-control", "no-store");
  return Response.json(body, { status, headers: selected });
};
const invalid = (): Response =>
  json(
    {
      error: {
        code: "pairing_invalid",
        message: "Esta vinculación ya no es válida. Inicia de nuevo.",
      },
    },
    httpInvalid
  );
type Decision = ReturnType<typeof decideBrowserLoginRedemption>;
type Redemption = Readonly<{
  db: D1Database;
  proof: typeof Proof.Type;
  pairing: typeof Pairing.Type;
  current: number;
}>;

const delayPoll = ({
  db,
  proof,
  pairing,
  decision,
}: Omit<Redemption, "current"> &
  Readonly<{ decision: Extract<Decision, { _tag: "SlowDown" }> }>): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    yield* attempt(() =>
      db
        .prepare(
          `UPDATE browser_login_pairings SET minimum_poll_interval_seconds = ? WHERE id = ? AND state = ?`
        )
        .bind(
          Math.min(decision.minimumPollIntervalSeconds, maximumPollSeconds),
          proof.pairingId,
          pairing.state
        )
        .run()
    );
    return json(
      { error: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds } },
      httpLimited,
      { "retry-after": String(decision.retryAfterSeconds) }
    );
  });
const recordPoll = ({
  db,
  proof,
  pairing,
  current,
  decision,
}: Redemption & Readonly<{ decision: Extract<Decision, { _tag: "Pending" }> }>): Effect.Effect<
  Response,
  void
> =>
  Effect.gen(function* () {
    const accepted = yield* attempt(() =>
      db
        .prepare(`UPDATE browser_login_pairings SET last_poll_at_ms = ?
    WHERE id = ? AND state = 'pending_approval' AND last_poll_at_ms IS ? AND expires_at_ms > ?`)
        .bind(current, proof.pairingId, pairing.last_poll_at_ms, current)
        .run()
    );
    return accepted.meta.changes !== 1
      ? invalid()
      : json(
          {
            status: "pending_approval",
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(pairing.expires_at_ms)),
            pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
          },
          httpPending
        );
  });
const consumePairing = ({
  db,
  proof,
  pairing,
  current,
}: Redemption): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if (pairing.user_id === null) return invalid();
    const issuance = yield* prepareWebSessionIssuance({
      db,
      pairingId: proof.pairingId,
      userId: pairing.user_id,
      current,
    });
    const committed = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            `UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ? AND user_id = ? AND state = 'ready' AND expires_at_ms > ? AND wrong_attempts < ?`
          )
          .bind(proof.pairingId, pairing.user_id, current, maximumWrongVerifierAttempts),
        issuance.statement,
      ])
    );
    const issued = committed[1];
    return issued === undefined ? invalid() : issuance.complete(issued);
  });

export const redeemKnownProof = (
  db: D1Database,
  proof: typeof Proof.Type,
  pairing: typeof Pairing.Type
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const decision = decideBrowserLoginRedemption({
      lifecycle: pairing.state,
      verifierMatches: sameDigest(
        pairing.verifier_digest,
        yield* attempt(() => digest(proof.privateVerifier))
      ),
      wrongVerifierAttempts: pairing.wrong_attempts,
      minimumPollIntervalSeconds: pairing.minimum_poll_interval_seconds,
      lastAcceptedPollAt: Option.map(
        Option.fromNullishOr(pairing.last_poll_at_ms),
        DateTime.makeUnsafe
      ),
      expiresAt: DateTime.makeUnsafe(pairing.expires_at_ms),
      attemptedAt: DateTime.makeUnsafe(current),
    });
    switch (decision._tag) {
      case "WrongVerifier":
        yield* attempt(() => recordWrongVerifier(db, proof.pairingId));
        return invalid();
      case "SlowDown":
        return yield* delayPoll({ db, proof, pairing, decision });
      case "Pending":
        return yield* recordPoll({ db, proof, pairing, current, decision });
      case "Consume":
        return yield* consumePairing({ db, proof, pairing, current });
      case "Expired":
      case "Invalid":
        return invalid();
    }
  });
