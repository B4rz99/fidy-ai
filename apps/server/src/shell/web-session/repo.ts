import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";

/** Revokes the active session matching one digest through the narrow pre-subject gateway. */
export const revokeWebSession = Effect.fn("WebSession.revoke")(function* (
  bearerDigest: Uint8Array,
  revokedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const { revoked } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ revoked: Schema.Boolean }),
    execute: () => sql`
      SELECT fidy_revoke_web_session(${bearerDigest}, ${revokedAt}) AS revoked
    `,
  })(undefined).pipe(Effect.orDie);
  return revoked;
});
