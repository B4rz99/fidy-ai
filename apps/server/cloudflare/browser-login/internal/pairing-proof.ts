import {
  BrowserLoginPairingId,
  BrowserLoginPrivateVerifier,
  browserLoginPollingIntervalSeconds,
} from "../../../src/core/browser-login/contract";
import { maximumWrongVerifierAttempts } from "../../../src/core/browser-login/operations";
import { UserId } from "../../../src/core/identity/contract";
import { Schema } from "effect";

export const digestBytes = 32;
export const maximumPollSeconds = 60;
const maximumByte = 255;
export const Proof = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: BrowserLoginPrivateVerifier,
});
export const Pairing = Schema.Struct({
  user_id: Schema.NullOr(UserId),
  verifier_digest: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumByte }))
  ).check(Schema.isLengthBetween(digestBytes, digestBytes)),
  expires_at_ms: Schema.Finite,
  wrong_attempts: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: maximumWrongVerifierAttempts })
  ),
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_interval_seconds: Schema.Int.check(
    Schema.isBetween({ minimum: browserLoginPollingIntervalSeconds, maximum: maximumPollSeconds })
  ),
  state: Schema.Literals(["pending_approval", "ready", "consumed", "invalidated"]),
});
export const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
export const sameDigest = (expected: ReadonlyArray<number>, received: Uint8Array): boolean => {
  if (expected.length !== digestBytes || received.length !== digestBytes) return false;
  let difference = 0;
  for (let index = 0; index < digestBytes; index++) {
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0);
  }
  return difference === 0;
};
export const recordWrongVerifier = (db: D1Database, pairingId: string): Promise<D1Result> =>
  db
    .prepare(`UPDATE browser_login_pairings
  SET wrong_attempts = wrong_attempts + 1,
    state = CASE WHEN wrong_attempts + 1 >= ? THEN 'invalidated' ELSE state END,
    user_id = CASE WHEN wrong_attempts + 1 >= ? THEN NULL ELSE user_id END
  WHERE id = ? AND state IN ('pending_approval', 'ready') AND wrong_attempts < ?`)
    .bind(
      maximumWrongVerifierAttempts,
      maximumWrongVerifierAttempts,
      pairingId,
      maximumWrongVerifierAttempts
    )
    .run();
