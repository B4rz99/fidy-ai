import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { BrowserLoginPairingId } from "~/core/browser-login/reference";
import type { WebSessionId } from "~/core/web-session/reference";

type RedeemPairingToWebSessionInput = Readonly<{
  pairingId: BrowserLoginPairingId;
  sessionId: WebSessionId;
  bearerDigest: Uint8Array;
  pairedAt: DateTime.Utc;
  freshUntil: DateTime.Utc;
  idleExpiresAt: DateTime.Utc;
  hardExpiresAt: DateTime.Utc;
}>;

/** Atomically consumes one Ready pairing and creates its digest-only WebSession. */
export const redeemPairingToWebSession = Effect.fn("WebAuth.redeemPairingToWebSession")(function* (
  input: RedeemPairingToWebSessionInput
) {
  const sql = yield* SqlClient.SqlClient;
  const { changed } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ changed: Schema.Boolean }),
    execute: () => sql`
        SELECT fidy_redeem_pairing_to_web_session(
          ${input.pairingId}::uuid, ${input.sessionId}::uuid, ${input.bearerDigest},
          ${input.pairedAt}, ${input.freshUntil}, ${input.idleExpiresAt}, ${input.hardExpiresAt}
        ) AS changed
      `,
  })(undefined).pipe(Effect.orDie);
  return changed;
});
