import { type DateTime, Effect, type Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { ManualPATRequestId, PAT, ResolvedToken } from "~/core/tokens/model";

/** A lowercase SHA-256 digest used only at the token storage boundary. */
export const TokenHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TokenHash")
);
export type TokenHash = typeof TokenHash.Type;

const PATGrant = PAT.mapFields(Struct.omit(["_tag", "lastUsedAt", "createdAt"]));
const SeedPATGrant = Schema.Struct({
  ...PATGrant.fields,
  tokenHash: TokenHash,
  expiresAt: Schema.DateTimeUtcFromDate,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  createdAt: Schema.DateTimeUtcFromDate,
});
const SeedPATRow = Schema.Struct({
  subjectUserId: UserId,
  ...SeedPATGrant.fields,
});

const TokenLookup = Schema.Struct({ tokenHash: TokenHash });
const ManualPATInsert = Schema.Struct({
  subjectUserId: UserId,
  ...SeedPATGrant.fields,
  requestId: ManualPATRequestId,
});

const IssuanceAdmission = Schema.Struct({
  issuanceCount: Schema.Int,
  retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
});

const UseTokenRow = Schema.Struct({
  ...TokenLookup.fields,
  usedAt: Schema.DateTimeUtcFromDate,
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
        id, user_id, short_id, recipient_label, token_hash, scopes, lifetime_days, last_used_at,
        expires_at, revoked_at, created_at
      )
      VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.recipientLabel},
        ${row.tokenHash}, ${row.scopes}, ${row.lifetimeDays}, NULL, ${row.expiresAt},
        ${row.revokedAt}, ${row.createdAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        short_id = EXCLUDED.short_id,
        recipient_label = EXCLUDED.recipient_label,
        token_hash = EXCLUDED.token_hash,
        scopes = EXCLUDED.scopes,
        lifetime_days = EXCLUDED.lifetime_days,
        last_used_at = NULL,
        expires_at = EXCLUDED.expires_at,
        revoked_at = EXCLUDED.revoked_at,
        created_at = EXCLUDED.created_at
      RETURNING token_hash AS "tokenHash"
    `,
    })({ subjectUserId, ...grant }).pipe(Effect.orDie)
  );

  return row.tokenHash;
});

/** Reports whether this User already consumed one browser issuance request identity. */
export const hasConsumedPATRequest = Effect.fn("hasConsumedPATRequest")(function* (
  subjectUserId: UserId,
  requestId: ManualPATRequestId
) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: Schema.Struct({ subjectUserId: UserId, requestId: ManualPATRequestId }),
    Result: Schema.Struct({ consumed: Schema.Boolean }),
    execute: (request) => sql`
      SELECT EXISTS (
        SELECT 1 FROM tokens
        WHERE user_id = ${request.subjectUserId}
          AND issuance_request_id = ${request.requestId}
      ) AS consumed
    `,
  })({ subjectUserId, requestId }).pipe(Effect.orDie);
  return result.consumed;
});

/** Counts recent manual PATs for one User and computes the rolling-window retry delay. */
export const getPATIssuanceAdmission = Effect.fn("getPATIssuanceAdmission")(function* (
  subjectUserId: UserId,
  attemptedAt: DateTime.Utc,
  windowMinutes: number
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      subjectUserId: UserId,
      attemptedAt: Schema.DateTimeUtcFromDate,
      windowMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
    Result: IssuanceAdmission,
    execute: (request) => sql`
      SELECT count(*)::int AS "issuanceCount",
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(token.created_at) + (${request.windowMinutes} * interval '1 minute')
            - ${request.attemptedAt}::timestamptz
        )))::int, 1) AS "retryAfterSeconds"
      FROM tokens AS token
      JOIN consent_records AS consent ON consent.pat_id = token.id
      WHERE token.user_id = ${request.subjectUserId}
        AND consent.decision_origin = 'authenticated-web'
        AND token.created_at > ${request.attemptedAt}::timestamptz
          - (${request.windowMinutes} * interval '1 minute')
    `,
  })({ subjectUserId, attemptedAt, windowMinutes }).pipe(Effect.orDie);
});

/**
 * Inserts one new digest-only PAT grant inside the caller-owned User transaction.
 * The bearer type is absent from this relational boundary by construction.
 */
export const insertPATInScope = Effect.fn("insertPATInScope")(function* (
  subjectUserId: UserId,
  grant: Omit<typeof ManualPATInsert.Type, "subjectUserId">
) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.void({
    Request: ManualPATInsert,
    execute: (row) => sql`
      INSERT INTO tokens (
        id, user_id, short_id, recipient_label, token_hash, scopes, lifetime_days, last_used_at,
        expires_at, revoked_at, created_at, issuance_request_id
      ) VALUES (
        ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.recipientLabel},
        ${row.tokenHash}, ${row.scopes}, ${row.lifetimeDays}, NULL, ${row.expiresAt},
        ${row.revokedAt}, ${row.createdAt}, ${row.requestId}
      )
    `,
  })({ subjectUserId, ...grant }).pipe(Effect.orDie);
});

/**
 * Atomically resolves a bearer hash to its stable User and records that the
 * valid token was used. Absence is authentication data, not a database error;
 * the shared authorization middleware decides that it means HTTP 401.
 */
export const useToken = ({
  tokenHash,
  usedAt,
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
        FROM fidy_use_token(${row.tokenHash}, ${row.usedAt})
      `,
    })({ tokenHash, usedAt })
  ).pipe(Effect.orDie);
