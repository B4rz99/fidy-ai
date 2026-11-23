import { ConsentSubject, PATRevocationProtection } from "~/shell/consent/contract";
import type { PATActivityAuthority } from "~/shell/audit/contract";
import { type UserId } from "~/core/identity/contract";
import { Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import {
  type ActivePATList,
  type CreateManualPATPayload,
  PATActivityMetadata,
} from "~/core/tokens/contract";
import { type Unavailable } from "~/shell/public-http/contract";
import {
  patMetadataQuery,
  patMetadataResponseFromRows,
  listPATsResponse as readPATs,
} from "~/shell/tokens/internal/list-pats";
import { type OwnedStatement, type PreparedRead } from "~/shell/owner-write/contract";
import {
  expiredPATConsentIdentities,
  expiredPairingConsentIdentities,
  protectConsentAuthority,
  protectConsentStatement,
  protectPATRevocationStatement,
} from "~/shell/consent/operations";
import { type FreshSessionSubject } from "~/shell/web-session/contract";
import {
  freshSessionExists,
  freshSessionParams,
  liveSessionConditions,
} from "~/shell/web-session/operations";
import {
  type PATAuthority,
  PATGrantSelection,
  type PATSubject,
  PairingGrantSelection,
} from "./contract";

export const pairingMilliseconds = 600_000;

export const maxPairingsPerWindow = 4000;

export const maxActivePATs = 100;

export const issuanceWindowMilliseconds = 600_000;

export const maxIssuancesPerUserWindow = 20;

type ManualPATInput = Readonly<{
  grant: typeof CreateManualPATPayload.Type.grant;
  requestId: string;
  patId: string;
  shortId: string;
  bearerDigest: Uint8Array;
  createdAt: number;
  current: number;
  expires: number;
}>;

export const issueManualPAT = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: ManualPATInput }>): OwnedStatement => {
  const protectedIssue = protectConsentStatement({
    statement: {
      sql: `INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
        created_at_ms,issued_at_ms,expires_at_ms,request_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${freshSessionExists}`,
      params: [
        input.patId,
        session.user_id,
        input.shortId,
        input.bearerDigest,
        input.grant.recipientLabel,
        JSON.stringify(input.grant.scopes),
        input.grant.lifetimeDays,
        input.createdAt,
        input.current,
        input.expires,
        input.requestId,
        ...freshSessionParams({ session, time: input.current }),
      ],
    },
    subject: ConsentSubject.User({ userId: session.user_id }),
    requirement: "unrevoked",
  });

  return {
    sql: `${protectedIssue.sql}
      AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
      AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`,
    params: [
      ...protectedIssue.params,
      session.user_id,
      input.current,
      maxActivePATs,
      session.user_id,
      input.current - issuanceWindowMilliseconds,
      maxIssuancesPerUserWindow,
    ],
  };
};

type ApprovalInput = Readonly<{ pairingId: string; current: number; expires: number }>;

export const approvePairingGrant = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: ApprovalInput }>): OwnedStatement => {
  const live = liveSessionConditions({ session, current: input.current });

  return protectConsentStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'approved_awaiting_claim', user_id = ?, approved_at_ms = ?, pat_expires_at_ms = ?
        WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND ${live.sql}`,
      params: [
        session.user_id,
        input.current,
        input.expires,
        input.pairingId,
        input.current,
        ...live.params,
      ],
    },
    subject: ConsentSubject.User({ userId: session.user_id }),
    requirement: "unrevoked",
  });
};

export const claimPairingGrant = (
  input: Readonly<{ pairingId: string; userId: string; proofDigest: Uint8Array; current: number }>
): OwnedStatement => {
  const protectedClaim = protectConsentStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'claimed' WHERE id = ? AND state = 'approved_awaiting_claim'
        AND user_id = ? AND proof_digest = ? AND approved_at_ms <= ? AND expires_at_ms > ? AND pat_expires_at_ms > ?`,
      params: [
        input.pairingId,
        input.userId,
        input.proofDigest,
        input.current,
        input.current,
        input.current,
      ],
    },
    subject: ConsentSubject.Owner({ column: "pat_pairings.user_id" }),
    requirement: "unrevoked",
  });

  return {
    sql: `${protectedClaim.sql}
      AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
      AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`,
    params: [
      ...protectedClaim.params,
      input.userId,
      input.current,
      maxActivePATs,
      input.userId,
      input.current - issuanceWindowMilliseconds,
      maxIssuancesPerUserWindow,
    ],
  };
};

export const recordLivePATUse = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): OwnedStatement => {
  const authority = livePATAuthority({ subject, current });

  return {
    sql: `UPDATE pats SET last_used_at_ms = ? WHERE ${authority.predicate}`,
    params: [current, ...authority.bindings],
  };
};

export const recordAuditedPATUseFromAuthority = ({
  authority,
  current,
  evidence,
}: Readonly<{
  authority: PATAuthority;
  current: number;
  evidence: OwnedStatement;
}>): OwnedStatement => ({
  sql: `UPDATE pats SET last_used_at_ms = ? WHERE ${authority.predicate} AND changes() = 1 AND EXISTS (${evidence.sql})`,
  params: [current, ...authority.bindings, ...evidence.params],
});

type RevokeOneInput = Readonly<{ shortId: string; current: number }>;

export const revokeOnePAT = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: RevokeOneInput }>): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NULL
        AND expires_at_ms > ? AND ${freshSessionExists}`,
      params: [
        input.current,
        session.user_id,
        input.shortId,
        input.current,
        ...freshSessionParams({ session, time: input.current }),
      ],
    },
    evidence: PATRevocationProtection.UserPAT({
      sessionId: session.id,
      occurredAtMs: Option.some(input.current),
    }),
  });

export const revokeEveryPAT = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL
        AND expires_at_ms > ? AND ${freshSessionExists}`,
      params: [
        current,
        session.user_id,
        current,
        ...freshSessionParams({ session, time: current }),
      ],
    },
    evidence: PATRevocationProtection.UserPAT({
      sessionId: session.id,
      occurredAtMs: Option.none(),
    }),
  });

export const revokeEveryPairing = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE user_id = ?
        AND state = 'approved_awaiting_claim' AND ${freshSessionExists}`,
      params: [session.user_id, ...freshSessionParams({ session, time: current })],
    },
    evidence: PATRevocationProtection.UserPairing({ sessionId: session.id }),
  });

export const expireApprovedPairings = (current: number): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE state = 'approved_awaiting_claim'
        AND expires_at_ms <= ?`,
      params: [current],
    },
    evidence: PATRevocationProtection.ExpiredPairing(),
  });

export const expireFixedPATs = (current: number): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pats SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms <= ?`,
      params: [current, current],
    },
    evidence: PATRevocationProtection.ExpiredPAT(),
  });

export const sweepUnapprovedPairings = ({
  current,
  limit,
}: Readonly<{ current: number; limit: number }>): OwnedStatement => ({
  sql: `DELETE FROM pat_pairings WHERE id IN (
    SELECT id FROM pat_pairings WHERE state = 'pending_approval' AND user_id IS NULL
    AND created_at_ms <= ? ORDER BY created_at_ms LIMIT ?)`,
  params: [current - pairingMilliseconds, limit],
});

export const pairingCapacityQuery = (current: number): OwnedStatement => ({
  sql: "SELECT 1 WHERE (SELECT count(*) FROM pat_pairings WHERE created_at_ms>?)<?",
  params: [current - pairingMilliseconds, maxPairingsPerWindow],
});

export const startPairingGrant = (
  input: Readonly<{
    id: string;
    publicCode: string;
    proofDigest: Uint8Array;
    recipientLabel: string;
    scopes: ReadonlyArray<string>;
    lifetimeDays: number;
    current: number;
    expires: number;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_pairings
    (id,public_code,proof_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,expires_at_ms)
    SELECT ?,?,?,?,?,?,?,? WHERE changes() = 1
    AND (SELECT count(*) FROM pat_pairings WHERE created_at_ms > ?) < ?`,
  params: [
    input.id,
    input.publicCode,
    input.proofDigest,
    input.recipientLabel,
    JSON.stringify(input.scopes),
    input.lifetimeDays,
    input.current,
    input.expires,
    input.current - pairingMilliseconds,
    maxPairingsPerWindow,
  ],
});

export const recordWrongPairingProof = (
  input: Readonly<{ attempts: number; pairingId: string; state: string; previous: number }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET wrong_attempts = ? WHERE id = ? AND state = ? AND wrong_attempts = ?`,
  params: [input.attempts, input.pairingId, input.state, input.previous],
});

export const slowPairingPoll = (
  input: Readonly<{ seconds: number; pairingId: string; state: string }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET minimum_poll_seconds = ? WHERE id = ? AND state = ?`,
  params: [input.seconds, input.pairingId, input.state],
});

export const recordPendingPoll = (
  input: Readonly<{ current: number; pairingId: string; lastPoll: Option.Option<number> }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET last_poll_at_ms = ? WHERE id = ?
    AND state = 'pending_approval' AND last_poll_at_ms ${Option.isSome(input.lastPoll) ? "= ?" : "IS NULL"} AND expires_at_ms > ?`,
  params: [input.current, input.pairingId, ...Option.toArray(input.lastPoll), input.current],
});

export const insertClaimedPAT = (
  input: Readonly<{
    patId: string;
    shortId: string;
    bearerDigest: Uint8Array;
    recipientLabel: string;
    scopesJson: string;
    lifetimeDays: number;
    approvedAt: number;
    current: number;
    expires: number;
    pairingId: string;
    userId: string;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
    created_at_ms,issued_at_ms,expires_at_ms,pairing_id)
    SELECT ?,user_id,?,?,?,?,?,?,?,?,id
    FROM pat_pairings WHERE id = ? AND state = 'claimed' AND user_id = ? AND changes() = 1`,
  params: [
    input.patId,
    input.shortId,
    input.bearerDigest,
    input.recipientLabel,
    input.scopesJson,
    input.lifetimeDays,
    input.approvedAt,
    input.current,
    input.expires,
    input.pairingId,
    input.userId,
  ],
});

const liveCredentialPredicate = `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`;

export const livePATCredential = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority =>
  protectConsentAuthority({
    authority: {
      table: "pats",
      predicate: liveCredentialPredicate,
      bindings: [subject.patId, subject.userId, subject.digest, current],
    },
    subject: ConsentSubject.Owner({ column: "pats.user_id" }),
    requirement: "unrevoked",
  });

export const livePATAuthority = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => {
  const credential = livePATCredential({ subject, current });

  return {
    ...credential,
    predicate: `${credential.predicate}
      AND ${Option.isSome(subject.requiredScope) ? "EXISTS (SELECT 1 FROM json_each(pats.scopes_json) WHERE value = ?)" : "0"}`,
    bindings: [...credential.bindings, ...Option.toArray(subject.requiredScope)],
  };
};

export const listPATsResponse = (
  userId: UserId
): Effect.Effect<
  {
    readonly data: ActivePATList;
    readonly next: ReadonlyArray<never>;
  },
  Unavailable,
  SqlClient.SqlClient
> => readPATs(userId);

export const preparePATMetadata = (
  input: Readonly<{
    current: number;
    authority: Readonly<{
      table: "web_sessions" | "hosted_turns";
      predicate: string;
      bindings: ReadonlyArray<string | number | Uint8Array>;
    }>;
  }> &
    (Readonly<{ userId: string }> | Readonly<{ users: OwnedStatement }>)
): PreparedRead<
  {
    readonly data: ActivePATList;
    readonly next: ReadonlyArray<never>;
  },
  Unavailable
> => {
  const metadata = patMetadataQuery({ ...input, session: Option.none() });

  return {
    statement: {
      sql: `SELECT * FROM (${metadata.sql}) WHERE EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
      params: [...metadata.params, ...input.authority.bindings],
    },
    decode: (rows) => patMetadataResponseFromRows(rows),
  };
};

export const patExpiryCompletion = (current: number): OwnedStatement => {
  const evidence = expiredPATConsentIdentities(current);

  return {
    sql: `INSERT INTO sql_assertions (scope, accepted) SELECT 'pat_atomic', CASE WHEN NOT EXISTS (
        SELECT 1 FROM (${evidence.sql}) r JOIN pats p ON p.id = r.id
        WHERE p.revoked_at_ms IS NULL
      ) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted
      WHERE sql_assertions.accepted <> excluded.accepted`,
    params: evidence.params,
  };
};

export const pairingExpiryCompletion = (current: number): OwnedStatement => {
  const evidence = expiredPairingConsentIdentities(current);

  return {
    sql: `INSERT INTO sql_assertions (scope, accepted) SELECT 'pat_atomic', CASE WHEN NOT EXISTS (
        SELECT 1 FROM (${evidence.sql}) r JOIN pat_pairings p ON p.id = r.id
        WHERE p.state = 'approved_awaiting_claim'
      ) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted
      WHERE sql_assertions.accepted <> excluded.accepted`,
    params: evidence.params,
  };
};

export const patRevokeAllCompletion = `INSERT INTO sql_assertions (scope, accepted) SELECT 'pat_atomic', CASE WHEN NOT EXISTS (
  SELECT 1 FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
) AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted`;

export const patOwnershipQuery = (
  input: Readonly<{ patId: string; userId: string }>
): OwnedStatement => ({
  sql: "SELECT 1 FROM pats WHERE id = ? AND user_id = ?",
  params: [input.patId, input.userId],
});

export const patIdentityQuery = (
  input: Readonly<{ userId: string; shortId: string }>
): OwnedStatement => ({
  sql: "SELECT id FROM pats WHERE user_id = ? AND short_id = ?",
  params: [input.userId, input.shortId],
});

export const revocablePATGrants = (
  input: Readonly<{ userId: string; current: number; shortId: Option.Option<string> }>
): PATGrantSelection =>
  PATGrantSelection.PATGrants({
    statement: {
      sql: `SELECT id,user_id,request_id,pairing_id FROM pats WHERE user_id = ?
    AND revoked_at_ms IS NULL AND expires_at_ms > ? ${Option.isSome(input.shortId) ? "AND short_id = ?" : ""}`,
      params: [input.userId, input.current, ...Option.toArray(input.shortId)],
    },
  });

export const revocablePairingGrants = (userId: string): PairingGrantSelection =>
  PairingGrantSelection.PairingGrants({
    statement: {
      sql: "SELECT id,user_id FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'",
      params: [userId],
    },
  });

export const expiredPATGrants = (
  input: Readonly<{ current: number; limit: number }>
): PATGrantSelection =>
  PATGrantSelection.PATGrants({
    statement: {
      sql: `SELECT id,user_id,request_id,pairing_id FROM pats WHERE revoked_at_ms IS NULL
    AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?`,
      params: [input.current, input.limit],
    },
  });

export const expiredPairingGrants = (
  input: Readonly<{ current: number; limit: number }>
): PairingGrantSelection =>
  PairingGrantSelection.PairingGrants({
    statement: {
      sql: `SELECT id,user_id FROM pat_pairings WHERE state = 'approved_awaiting_claim'
    AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?`,
      params: [input.current, input.limit],
    },
  });

export const preparePATActivityMetadata = (
  input: Readonly<{
    userId: string;
    shortId: string;
    authority: PATActivityAuthority;
  }>
): PreparedRead<Option.Option<PATActivityMetadata>, Schema.SchemaError> => ({
  statement: {
    sql: `SELECT short_id,recipient_label,scopes_json,created_at_ms,last_used_at_ms,expires_at_ms,revoked_at_ms
      FROM pats WHERE user_id = ? AND short_id = ?
      AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate}) LIMIT 1`,
    params: [input.userId, input.shortId, ...input.authority.bindings],
  },
  decode: (raw) =>
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            short_id: PATActivityMetadata.fields.shortId,
            recipient_label: PATActivityMetadata.fields.recipientLabel,
            scopes_json: Schema.String,
            created_at_ms: Schema.DateTimeUtcFromMillis,
            last_used_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
            expires_at_ms: Schema.DateTimeUtcFromMillis,
            revoked_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
          })
        ).check(Schema.isMaxLength(1))
      )(raw);

      const row = rows[0];

      if (row === undefined) return Option.none();

      const scopes = yield* Schema.decodeEffect(
        Schema.fromJsonString(PATActivityMetadata.fields.scopes)
      )(row.scopes_json);

      return Option.some(
        yield* Schema.decodeEffect(Schema.toType(PATActivityMetadata))({
          shortId: row.short_id,
          recipientLabel: row.recipient_label,
          scopes,
          createdAt: row.created_at_ms,
          lastUsedAt: row.last_used_at_ms,
          expiresAt: row.expires_at_ms,
          revokedAt: row.revoked_at_ms,
        })
      );
    }),
});
