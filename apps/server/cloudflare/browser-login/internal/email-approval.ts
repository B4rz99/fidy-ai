import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { decidePendingBrowserLoginProof } from "../../../src/core/browser-login/operations";
import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";
import type {
  BrowserPairingApprovalStatement,
  PendingBrowserPairingQuery,
  PendingBrowserPairingRequest,
} from "../contract";

const digestBytes = 32;
const Pairing = Schema.Struct({
  state: Schema.Literals(["pending_approval", "ready", "consumed", "invalidated"]),
  verifier_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  wrong_attempts: Schema.Int,
  expires_at_ms: Schema.Finite,
});
const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));
const sameDigest = (expected: ReadonlyArray<number>, received: Uint8Array): boolean => {
  if (expected.length !== digestBytes || received.length !== digestBytes) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < digestBytes; index++) {
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0);
  }
  return difference === 0;
};
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
export const provePendingPairing = ({
  db,
  pairingId,
  privateVerifier: verifier,
}: PendingBrowserPairingRequest): Promise<Option.Option<number>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT state, verifier_digest, wrong_attempts, expires_at_ms
    FROM browser_login_pairings WHERE id = ?`)
          .bind(pairingId)
          .first()
      );
      if (raw === null) return Option.none();
      const pairing = Schema.decodeUnknownOption(Pairing)(raw);
      if (Option.isNone(pairing)) return Option.none();
      const current = yield* Clock.currentTimeMillis;
      const decision = decidePendingBrowserLoginProof({
        lifecycle: pairing.value.state,
        verifierMatches: sameDigest(
          pairing.value.verifier_digest,
          yield* attempt(() => sha256(verifier))
        ),
        wrongVerifierAttempts: pairing.value.wrong_attempts,
        expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(current),
      });
      if (decision._tag === "WrongVerifier") {
        yield* attempt(() =>
          db
            .prepare(`UPDATE browser_login_pairings SET wrong_attempts = ?, state = ?
      WHERE id = ? AND state = 'pending_approval' AND wrong_attempts = ? AND expires_at_ms > ?`)
            .bind(
              decision.wrongVerifierAttempts,
              decision.lifecycle,
              pairingId,
              pairing.value.wrong_attempts,
              current
            )
            .run()
        );
      }
      return decision._tag === "Accept" ? Option.some(pairing.value.expires_at_ms) : Option.none();
    })
  );

export const pendingPairingQuery = ({
  subject,
  current,
}: PendingBrowserPairingQuery): OwnedStatement => ({
  sql: `SELECT p.id AS pairingId, p.expires_at_ms AS expiresAt FROM browser_login_pairings AS p
    WHERE p.id = (SELECT pairingId FROM (${subject.sql})) AND p.state = 'pending_approval'
      AND p.expires_at_ms > ? AND p.wrong_attempts < 5`,
  params: [...subject.params, current],
});
export const prepareProvedApproval = ({
  db,
  pairingId,
  subject,
  current,
}: BrowserPairingApprovalStatement): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE browser_login_pairings SET state = 'ready', user_id = (SELECT userId FROM (${subject.sql}))
   WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ?
     AND EXISTS (SELECT 1 FROM (${subject.sql}))`
    )
    .bind(...subject.params, pairingId, current, ...subject.params);
