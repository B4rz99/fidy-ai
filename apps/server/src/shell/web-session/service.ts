import { Crypto, DateTime, Effect } from "effect";
import { normalizeOpaqueProof32 } from "~/core/_shared/opaque-proof";
import { revokeWebSession } from "./repo";

/**
 * Revokes a presented opaque bearer without exposing whether it matched an active WebSession.
 * HTTP span telemetry records bounded status and latency; no match result or bearer data is logged.
 */
export const logoutWebSession = Effect.fn("WebSession.logout")(function* (bearer: string) {
  const crypto = yield* Crypto.Crypto;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(normalizeOpaqueProof32(bearer)))
    .pipe(Effect.orDie);
  yield* revokeWebSession(bearerDigest, yield* DateTime.now);
});
