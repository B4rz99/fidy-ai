import { Effect, type Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { HostedTurnToken, PAT, ResolvedToken } from "~/core/tokens/model";

/** A lowercase SHA-256 digest used only at the token storage boundary. */
export const TokenHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TokenHash")
);
export type TokenHash = typeof TokenHash.Type;

const PATGrant = PAT.mapFields(Struct.omit(["_tag", "lastUsedAt", "createdAt"]));
const SeedPATGrant = Schema.Struct({
  ...PATGrant.fields,
  tokenHash: TokenHash,
  idleExpiresAt: Schema.DateTimeUtcFromDate,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  createdAt: Schema.DateTimeUtcFromDate,
});
const SeedPATRow = Schema.Struct({
  subjectUserId: UserId,
  ...SeedPATGrant.fields,
});

const HostedTurnTokenGrant = HostedTurnToken.mapFields(
  Struct.omit(["_tag", "lastUsedAt", "revokedAt"])
);
const StoreHostedTurnTokenRow = Schema.Struct({
  subjectUserId: UserId,
  tokenHash: TokenHash,
  storageIdleExpiresAt: Schema.DateTimeUtcFromDate,
  ...HostedTurnTokenGrant.fields,
  expiresAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});
const StoreHostedTurnTokenGrant = StoreHostedTurnTokenRow.mapFields(Struct.omit(["subjectUserId"]));
const RevokeHostedTurnTokenRow = Schema.Struct({
  subjectUserId: UserId,
  tokenId: HostedTurnToken.fields.id,
  revokedAt: Schema.DateTimeUtcFromDate,
});

const TokenLookup = Schema.Struct({ tokenHash: TokenHash });

const UseTokenRow = Schema.Struct({
  ...TokenLookup.fields,
  usedAt: Schema.DateTimeUtcFromDate,
  renewedIdleExpiresAt: Schema.DateTimeUtcFromDate,
});

const ResolvedTokenWithoutLastUsedAt = ResolvedToken.mapFields(Struct.omit(["lastUsedAt"]));
const ResolvedTokenRow = Schema.Struct({
  ...ResolvedTokenWithoutLastUsedAt.fields,
  lastUsedAt: Schema.DateTimeUtcFromDate,
});

/**
 * Stores a development token grant by hash and resets its usage timestamp.
 * The opaque bearer is not accepted by this relational seam, making plaintext
 * persistence impossible through this operation.
 */
export const upsertPAT = Effect.fn("upsertPAT")(function* (
  subjectUserId: UserId,
  grant: typeof SeedPATGrant.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOne({
      Request: SeedPATRow,
      Result: Schema.Struct({ tokenHash: TokenHash }),
      execute: (row) => sql`
      INSERT INTO tokens (
        id, user_id, short_id, token_hash, scopes, last_used_at,
        idle_expires_at, revoked_at, created_at, kind, expires_at
      )
      VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.tokenHash},
        ${row.scopes}, NULL, ${row.idleExpiresAt}, ${row.revokedAt}, ${row.createdAt},
        'pat', NULL
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
        kind = 'pat',
        expires_at = NULL
      RETURNING token_hash AS "tokenHash"
    `,
    })({ subjectUserId, ...grant }).pipe(Effect.orDie)
  );

  return row.tokenHash;
});

/**
 * Stores one hard-expiring HostedTurnToken by digest. The storage-only idle
 * deadline maintains the shared relational chronology but never authorizes or
 * extends this variant's absolute lifetime.
 */
export const insertHostedTurnToken = Effect.fn("insertHostedTurnToken")(function* (
  subjectUserId: UserId,
  grant: typeof StoreHostedTurnTokenGrant.Type
) {
  const input = StoreHostedTurnTokenRow.make({ subjectUserId, ...grant });
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOne({
      Request: StoreHostedTurnTokenRow,
      Result: Schema.Struct({ id: HostedTurnToken.fields.id }),
      execute: (row) => sql`
      INSERT INTO tokens (
        id, user_id, short_id, token_hash, scopes, last_used_at,
        idle_expires_at, revoked_at, created_at, kind, expires_at
      )
      VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.tokenHash}, ${row.scopes},
        NULL, ${row.storageIdleExpiresAt}, NULL, ${row.createdAt}, 'hosted-turn', ${row.expiresAt}
      )
      RETURNING id
    `,
    })(input).pipe(Effect.orDie)
  );
});

/**
 * Revokes one active HostedTurnToken owned by the subject User. Returns None when ownership,
 * token kind, or active state does not match; database failures are defects.
 */
export const revokeHostedTurnToken = Effect.fn("revokeHostedTurnToken")(function* (
  subjectUserId: UserId,
  tokenId: typeof HostedTurnToken.fields.id.Type,
  revokedAt: typeof Schema.DateTimeUtc.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOneOption({
      Request: RevokeHostedTurnTokenRow,
      Result: Schema.Struct({ id: HostedTurnToken.fields.id }),
      execute: (row) => sql`
      UPDATE tokens
      SET revoked_at = ${row.revokedAt}
      WHERE id = ${row.tokenId}
        AND user_id = ${row.subjectUserId}
        AND kind = 'hosted-turn'
        AND revoked_at IS NULL
      RETURNING id
    `,
    })({ subjectUserId, tokenId, revokedAt }).pipe(Effect.orDie)
  );
});

/**
 * Atomically resolves a bearer hash to its stable User and records that the
 * valid token was used. Absence is authentication data, not a database error;
 * the shared authorization middleware decides that it means HTTP 401.
 */
export const useToken = ({
  tokenHash,
  usedAt,
  renewedIdleExpiresAt,
}: typeof UseTokenRow.Type): Effect.Effect<
  Option.Option<ResolvedToken>,
  never,
  SqlClient.SqlClient
> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UseTokenRow,
      Result: ResolvedTokenRow,
      execute: (row) => sql`
        SELECT token_id AS "tokenId", subject_user_id AS "subjectUserId",
          scopes, last_used_at AS "lastUsedAt"
        FROM fidy_use_token(
          ${row.tokenHash}, ${row.usedAt}, ${row.renewedIdleExpiresAt}
        )
      `,
    })({ tokenHash, usedAt, renewedIdleExpiresAt })
  ).pipe(Effect.orDie);
