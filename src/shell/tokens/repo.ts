import { Effect, type Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/_shared/user";
import { HostedAgentToken, ResolvedAgentToken, UserAgentToken } from "~/core/tokens/model";

/** A lowercase SHA-256 digest used only at the AgentToken storage boundary. */
export const AgentTokenHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("AgentTokenHash")
);
export type AgentTokenHash = typeof AgentTokenHash.Type;

const AgentTokenGrant = UserAgentToken.mapFields(Struct.omit(["_tag", "lastUsedAt", "createdAt"]));
const SeedAgentTokenGrant = Schema.Struct({
  ...AgentTokenGrant.fields,
  tokenHash: AgentTokenHash,
  idleExpiresAt: Schema.DateTimeUtcFromDate,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  createdAt: Schema.DateTimeUtcFromDate,
});
const SeedAgentTokenRow = Schema.Struct({
  subjectUserId: UserId,
  ...SeedAgentTokenGrant.fields,
});

const HostedAgentTokenGrant = HostedAgentToken.mapFields(
  Struct.omit(["_tag", "lastUsedAt", "revokedAt"])
);
const StoreHostedAgentTokenRow = Schema.Struct({
  subjectUserId: UserId,
  tokenHash: AgentTokenHash,
  storageIdleExpiresAt: Schema.DateTimeUtcFromDate,
  ...HostedAgentTokenGrant.fields,
  expiresAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});
const StoreHostedAgentTokenGrant = StoreHostedAgentTokenRow.mapFields(
  Struct.omit(["subjectUserId"])
);
const RevokeHostedAgentTokenRow = Schema.Struct({
  subjectUserId: UserId,
  tokenId: HostedAgentToken.fields.id,
  revokedAt: Schema.DateTimeUtcFromDate,
});

const AgentTokenLookup = Schema.Struct({ tokenHash: AgentTokenHash });

const UseAgentTokenRow = Schema.Struct({
  ...AgentTokenLookup.fields,
  usedAt: Schema.DateTimeUtcFromDate,
  renewedIdleExpiresAt: Schema.DateTimeUtcFromDate,
});

const ResolvedAgentTokenWithoutLastUsedAt = ResolvedAgentToken.mapFields(
  Struct.omit(["lastUsedAt"])
);
const ResolvedAgentTokenRow = Schema.Struct({
  ...ResolvedAgentTokenWithoutLastUsedAt.fields,
  lastUsedAt: Schema.DateTimeUtcFromDate,
});

/**
 * Stores a development AgentToken grant by hash and resets its usage timestamp.
 * The opaque bearer is not accepted by this relational seam, making plaintext
 * persistence impossible through this operation.
 */
export const upsertAgentToken = Effect.fn("upsertAgentToken")(function* (
  subjectUserId: UserId,
  grant: typeof SeedAgentTokenGrant.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: SeedAgentTokenRow,
    Result: Schema.Struct({ tokenHash: AgentTokenHash }),
    execute: (row) => sql`
      INSERT INTO agent_tokens (
        id, user_id, short_id, token_hash, scopes, last_used_at,
        idle_expires_at, revoked_at, created_at, kind, expires_at
      )
      VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.tokenHash},
        ${row.scopes}, NULL, ${row.idleExpiresAt}, ${row.revokedAt}, ${row.createdAt},
        'user', NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        short_id = EXCLUDED.short_id,
        token_hash = EXCLUDED.token_hash,
        scopes = EXCLUDED.scopes,
        last_used_at = NULL,
        idle_expires_at = EXCLUDED.idle_expires_at,
        revoked_at = EXCLUDED.revoked_at,
        created_at = EXCLUDED.created_at,
        kind = 'user',
        expires_at = NULL
      RETURNING token_hash AS "tokenHash"
    `,
  })({ subjectUserId, ...grant }).pipe(Effect.orDie);

  return row.tokenHash;
});

/**
 * Stores one hard-expiring HostedAgentToken by digest. The storage-only idle
 * deadline maintains the shared relational chronology but never authorizes or
 * extends this variant's absolute lifetime.
 */
export const insertHostedAgentToken = Effect.fn("insertHostedAgentToken")(function* (
  subjectUserId: UserId,
  grant: typeof StoreHostedAgentTokenGrant.Type
) {
  const input = StoreHostedAgentTokenRow.make({ subjectUserId, ...grant });
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.findOne({
    Request: StoreHostedAgentTokenRow,
    Result: Schema.Struct({ id: HostedAgentToken.fields.id }),
    execute: (row) => sql`
      INSERT INTO agent_tokens (
        id, user_id, short_id, token_hash, scopes, last_used_at,
        idle_expires_at, revoked_at, created_at, kind, expires_at
      )
      VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.tokenHash}, ${row.scopes},
        NULL, ${row.storageIdleExpiresAt}, NULL, ${row.createdAt}, 'hosted', ${row.expiresAt}
      )
      RETURNING id
    `,
  })(input).pipe(Effect.orDie);
});

/**
 * Revokes one active User-owned HostedAgentToken. Returns None when ownership,
 * token kind, or active state does not match; database failures are defects.
 */
export const revokeHostedAgentToken = Effect.fn("revokeHostedAgentToken")(function* (
  subjectUserId: UserId,
  tokenId: typeof HostedAgentToken.fields.id.Type,
  revokedAt: typeof Schema.DateTimeUtc.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: RevokeHostedAgentTokenRow,
    Result: Schema.Struct({ id: HostedAgentToken.fields.id }),
    execute: (row) => sql`
      UPDATE agent_tokens
      SET revoked_at = ${row.revokedAt}
      WHERE id = ${row.tokenId}
        AND user_id = ${row.subjectUserId}
        AND kind = 'hosted'
        AND revoked_at IS NULL
      RETURNING id
    `,
  })({ subjectUserId, tokenId, revokedAt }).pipe(Effect.orDie);
});

/**
 * Atomically resolves a bearer hash to its stable User and records that the
 * valid token was used. Absence is authentication data, not a database error;
 * the shared authorization middleware decides that it means HTTP 401.
 */
export const useAgentToken = ({
  tokenHash,
  usedAt,
  renewedIdleExpiresAt,
}: typeof UseAgentTokenRow.Type): Effect.Effect<
  Option.Option<ResolvedAgentToken>,
  never,
  SqlClient.SqlClient
> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UseAgentTokenRow,
      Result: ResolvedAgentTokenRow,
      execute: (row) => sql`
        WITH candidate AS MATERIALIZED (
          SELECT id
          FROM agent_tokens
          WHERE token_hash = ${row.tokenHash} AND revoked_at IS NULL
          FOR UPDATE
        ),
        auto_revoked AS (
          UPDATE agent_tokens AS token
          SET revoked_at = ${row.usedAt}
          FROM candidate
          WHERE token.id = candidate.id
            AND (
              (token.kind = 'user' AND token.idle_expires_at <= ${row.usedAt})
              OR
              (token.kind = 'hosted' AND token.expires_at <= ${row.usedAt})
            )
        ),
        active AS (
          UPDATE agent_tokens AS token
          SET last_used_at = GREATEST(token.last_used_at, ${row.usedAt}),
            idle_expires_at = GREATEST(token.idle_expires_at, ${row.renewedIdleExpiresAt})
          FROM candidate
          WHERE token.id = candidate.id
            AND (
              (token.kind = 'user' AND token.idle_expires_at > ${row.usedAt})
              OR
              (token.kind = 'hosted' AND token.expires_at > ${row.usedAt})
            )
          RETURNING token.id AS "tokenId", token.user_id AS "subjectUserId",
            token.scopes, token.last_used_at AS "lastUsedAt"
        )
        SELECT * FROM active
      `,
    })({ tokenHash, usedAt, renewedIdleExpiresAt })
  ).pipe(Effect.orDie);
