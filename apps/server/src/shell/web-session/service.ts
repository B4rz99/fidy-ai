import { Crypto, DateTime, Effect } from "effect";
import { normalizeOpaqueProof32 } from "~/core/_shared/opaque-proof";
import { webSessionIdleRenewalCandidate } from "~/core/web-session/rules";
import { revokeWebSession, useWebSession } from "./repo";

/** Hashes one already-bounded cookie value without accepting malformed proof text. */
export const hashWebSessionBearer = (
  bearer: string
): Effect.Effect<Uint8Array, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(normalizeOpaqueProof32(bearer)))
  ).pipe(Effect.orDie);

/** Resolves and renews one active WebSession without exposing credential material downstream. */
export const authenticateWebSession = Effect.fn("WebSession.authenticate")(function* (
  bearer: string,
  usedAt: DateTime.Utc
) {
  return yield* useWebSession(
    yield* hashWebSessionBearer(bearer),
    usedAt,
    webSessionIdleRenewalCandidate(usedAt)
  );
});

/**
 * Revokes a presented opaque bearer without exposing whether it matched an active WebSession.
 * HTTP span telemetry records bounded status and latency; no match result or bearer data is logged.
 */
export const logoutWebSession = Effect.fn("WebSession.logout")(function* (bearer: string) {
  yield* revokeWebSession(yield* hashWebSessionBearer(bearer), yield* DateTime.now);
});
