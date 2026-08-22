import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { WebSessionId } from "~/core/web-session/reference";

/** Persisted authority returned only after an active WebSession is atomically renewed. */
export const ResolvedWebSession = Schema.Struct({
  webSessionId: WebSessionId,
  subjectUserId: UserId,
  pairedAt: Schema.DateTimeUtcFromDate,
  freshUntil: Schema.DateTimeUtcFromDate,
  lastUsedAt: Schema.DateTimeUtcFromDate,
  idleExpiresAt: Schema.DateTimeUtcFromDate,
  hardExpiresAt: Schema.DateTimeUtcFromDate,
});

/** Decoded active WebSession authority, including immutable pairing and expiry boundaries. */
export type ResolvedWebSession = typeof ResolvedWebSession.Type;

/** Resolves and atomically renews one active digest through the narrow pre-subject gateway. */
export const useWebSession = Effect.fn("WebSession.use")(function* (
  bearerDigest: Uint8Array,
  usedAt: DateTime.Utc,
  requestedIdleExpiresAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ResolvedWebSession,
    execute: () => sql`
      SELECT
        web_session_id AS "webSessionId",
        subject_user_id AS "subjectUserId",
        paired_at AS "pairedAt",
        fresh_until AS "freshUntil",
        last_used_at AS "lastUsedAt",
        idle_expires_at AS "idleExpiresAt",
        hard_expires_at AS "hardExpiresAt"
      FROM fidy_use_web_session(${bearerDigest}, ${usedAt}, ${requestedIdleExpiresAt})
    `,
  })(undefined).pipe(Effect.orDie);
});

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
