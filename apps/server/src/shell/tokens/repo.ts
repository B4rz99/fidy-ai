import { type DateTime, Effect, type Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { ActivePATMetadata, ManualPATRequestId, PAT, ResolvedToken } from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { PATPairingId } from "~/core/tokens/pairing";

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
const PairedPATInsert = Schema.Struct({
  subjectUserId: UserId,
  pairingId: PATPairingId,
  id: PATId,
  shortId: PAT.fields.shortId,
  recipientLabel: PAT.fields.recipientLabel,
  scopes: PAT.fields.scopes,
  lifetimeDays: PAT.fields.lifetimeDays,
  expiresAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
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

const ActivePATMetadataRow = Schema.Struct({
  shortId: ActivePATMetadata.fields.shortId,
  recipientLabel: ActivePATMetadata.fields.recipientLabel,
  scopes: ActivePATMetadata.fields.scopes,
  createdAt: Schema.DateTimeUtcFromDate,
  lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  expiresAt: Schema.DateTimeUtcFromDate,
});

const LockedPATForRevocation = Schema.Struct({
  id: PATId,
  shortId: ActivePATMetadata.fields.shortId,
  tokenHash: Schema.OptionFromNullOr(TokenHash),
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});
export type LockedPATForRevocation = typeof LockedPATForRevocation.Type;

const LockedPATRevocationSelection = Schema.Struct({
  id: PATId,
  shortId: ActivePATMetadata.fields.shortId,
  countedActive: Schema.Boolean,
});
export type LockedPATRevocationSelection = typeof LockedPATRevocationSelection.Type;

/** Lists safe metadata for one User's usable PATs under an independently owned transaction. */
export const selectActivePATs = Effect.fn("selectActivePATs")(function* (
  subjectUserId: UserId,
  observedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findAll({
      Request: Schema.Struct({
        subjectUserId: UserId,
        observedAt: Schema.DateTimeUtcFromDate,
      }),
      Result: ActivePATMetadataRow,
      execute: (request) => sql`
        SELECT short_id AS "shortId", recipient_label AS "recipientLabel", scopes,
          created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
        FROM tokens
        WHERE user_id = ${request.subjectUserId}
          AND token_hash IS NOT NULL
          AND revoked_at IS NULL
          AND expires_at > ${request.observedAt}
        ORDER BY created_at, id
      `,
    })({ subjectUserId, observedAt }).pipe(Effect.orDie)
  );
});

/** Locks one safe-id candidate under explicit User ownership; absence also covers foreign rows. */
export const lockPATForRevocationInScope = Effect.fn("lockPATForRevocationInScope")(function* (
  subjectUserId: UserId,
  shortId: ActivePATMetadata["shortId"]
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ subjectUserId: UserId, shortId: ActivePATMetadata.fields.shortId }),
    Result: LockedPATForRevocation,
    execute: (request) => sql`
      SELECT id, short_id AS "shortId", token_hash AS "tokenHash", revoked_at AS "revokedAt"
      FROM tokens
      WHERE user_id = ${request.subjectUserId} AND short_id = ${request.shortId}
      FOR UPDATE
    `,
  })({ subjectUserId, shortId }).pipe(Effect.orDie);
});

/**
 * Locks all active PATs plus approved unclaimed PAT authorization in pairing-first order. Pairing
 * locks precede Token locks to match the anonymous claim path and avoid lock-order inversions.
 */
export const lockAllPATsForRevocationInScope = Effect.fn("lockAllPATsForRevocationInScope")(
  function* (subjectUserId: UserId, observedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.Struct({
        subjectUserId: UserId,
        observedAt: Schema.DateTimeUtcFromDate,
      }),
      Result: LockedPATRevocationSelection,
      execute: (request) => sql`
      WITH locked_pairings AS MATERIALIZED (
        SELECT id FROM pat_pairings
        WHERE user_id = ${request.subjectUserId} AND lifecycle = 'approved_awaiting_claim'
        ORDER BY id FOR UPDATE
      )
      SELECT token.id, token.short_id AS "shortId",
        (token.token_hash IS NOT NULL AND token.expires_at > ${request.observedAt}) AS "countedActive"
      FROM tokens AS token
      WHERE token.user_id = ${request.subjectUserId} AND token.revoked_at IS NULL
        AND (
          (token.token_hash IS NOT NULL AND token.expires_at > ${request.observedAt})
          OR token.pat_pairing_id IN (SELECT id FROM locked_pairings)
        )
      ORDER BY token.id
      FOR UPDATE OF token
    `,
    })({ subjectUserId, observedAt }).pipe(Effect.orDie);
  }
);

/** Closes every User-owned approved pairing selected by the pairing-first lock query. */
export const revokeApprovedPATPairingsInScope = Effect.fn("revokeApprovedPATPairingsInScope")(
  function* (subjectUserId: UserId, revokedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    UPDATE pat_pairings SET lifecycle = 'revoked_unclaimed', revoked_at = ${revokedAt}
    WHERE user_id = ${subjectUserId} AND lifecycle = 'approved_awaiting_claim'
  `.pipe(Effect.orDie);
  }
);

/** Transitions one selected claimed or approved-unclaimed PAT exactly once. */
export const revokeSelectedPATInScope = Effect.fn("revokeSelectedPATInScope")(function* (
  subjectUserId: UserId,
  patId: PATId,
  revokedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.findOne({
    Request: Schema.Struct({
      subjectUserId: UserId,
      patId: PATId,
      revokedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: Schema.Struct({ id: PATId }),
    execute: (request) => sql`
      UPDATE tokens SET revoked_at = ${request.revokedAt}
      WHERE id = ${request.patId} AND user_id = ${request.subjectUserId}
        AND revoked_at IS NULL
        AND (token_hash IS NOT NULL OR pat_pairing_id IS NOT NULL)
      RETURNING id
    `,
  })({ subjectUserId, patId, revokedAt }).pipe(Effect.orDie);
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

/** Inserts the one stable awaiting-claim PAT with no bearer digest. */
export const insertAwaitingClaimPATInScope = Effect.fn("insertAwaitingClaimPATInScope")(function* (
  subjectUserId: UserId,
  grant: Omit<typeof PairedPATInsert.Type, "subjectUserId">
) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.void({
    Request: PairedPATInsert,
    execute: (row) => sql`
        INSERT INTO tokens (
          id, user_id, short_id, recipient_label, token_hash, scopes, lifetime_days,
          last_used_at, expires_at, revoked_at, created_at, pat_pairing_id
        ) VALUES (
          ${row.id}, ${row.subjectUserId}, ${row.shortId}, ${row.recipientLabel}, NULL,
          ${row.scopes}, ${row.lifetimeDays}, NULL, ${row.expiresAt}, NULL,
          ${row.createdAt}, ${row.pairingId}
        )
      `,
  })({ subjectUserId, ...grant }).pipe(Effect.orDie);
});

/** Revokes one paired PAT inside the caller-owned User transaction. */
export const revokePairedPATInScope = Effect.fn("revokePairedPATInScope")(function* (
  subjectUserId: UserId,
  patId: PATId,
  revokedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Struct({
      subjectUserId: UserId,
      patId: PATId,
      revokedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: Schema.Struct({ changed: Schema.Boolean }),
    execute: (request) => sql`
      WITH changed AS (
        UPDATE tokens SET revoked_at = ${request.revokedAt}
        WHERE id = ${request.patId} AND user_id = ${request.subjectUserId}
          AND revoked_at IS NULL AND token_hash IS NULL
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed) AS changed
    `,
  })({ subjectUserId, patId, revokedAt }).pipe(Effect.orDie);
  return row.changed;
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
