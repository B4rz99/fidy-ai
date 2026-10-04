import { type UserId } from "~/core/identity/contract";
import { type Effect, Option } from "effect";
import { type SqlClient } from "effect/sql";
import { type ActivePATList, type CreateManualPATPayload } from "~/core/tokens/contract";
import { type Unavailable } from "~/shell/public-http/contract";
import {
  patMetadataQuery,
  patMetadataResponseFromRows,
  listPATsResponse as readPATs,
} from "~/shell/tokens/internal/list-pats";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import {
  expiredPATConsentIdentities,
  expiredPairingConsentIdentities,
  protectConsentAuthority,
  protectConsentStatement,
  protectPATRevocationStatement,
} from "~/shell/consent/operations";
import { type FreshSessionSubject } from "~/shell/web-session/contract";
import { freshSessionExists, freshSessionParams } from "~/shell/web-session/operations";
import {
  type PATAuthority,
  type PATGrantSelection,
  type PATSubject,
  type PairingGrantSelection,
} from "./contract";

export const pairingMilliseconds = 600_000;
// One source cannot exhaust this pool under the edge's 60-per-10-second budget.
const maxPairingsPerWindow = 4000;
const maxPairingsPerSource = 20;
const maximumReviewAttempts = 10;
export const maxActivePATs = 100;
export const issuanceWindowMilliseconds = 600_000;
export const maxIssuancesPerUserWindow = 20;

type ManualPATInput = Readonly<{
  grant: typeof CreateManualPATPayload.Type.grant;
  requestId: string;
  patId: string;
  shortId: string;
  bearerDigest: Uint8Array;
  current: number;
  expires: number;
}>;
/** Guard one reviewed User-owned manual PAT against stale authority and both issuance budgets. */
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
        input.current,
        input.current,
        input.expires,
        input.requestId,
        ...freshSessionParams({ session, time: input.current }),
      ],
    },
    subject: { _tag: "User", userId: session.user_id },
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
/** Bind an approved PATPairing to its reviewed User before the initiating client claims it. */
export const approvePairingGrant = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: ApprovalInput }>): OwnedStatement =>
  protectConsentStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'approved_awaiting_claim', user_id = ?, approved_at_ms = ?, pat_expires_at_ms = ?
        WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND ${freshSessionExists}`,
      params: [
        session.user_id,
        input.current,
        input.expires,
        input.pairingId,
        input.current,
        ...freshSessionParams({ session, time: input.current }),
      ],
    },
    subject: { _tag: "User", userId: session.user_id },
    requirement: "unrevoked",
  });

/** Consume a single User-bound PATPairing approval under current Consent and issuance limits. */
export const claimPairingGrant = (
  input: Readonly<{ pairingId: string; userId: string; current: number }>
): OwnedStatement => {
  const protectedClaim = protectConsentStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'claimed' WHERE id = ? AND state = 'approved_awaiting_claim'
        AND user_id = ? AND expires_at_ms > ?`,
      params: [input.pairingId, input.userId, input.current],
    },
    subject: { _tag: "Owner", column: "pat_pairings.user_id" },
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

/** Recheck bearer, Consent, scope, and lifetime alongside protected canonical work. */
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

/**
 * The same activity advance built from the exact live-authority gate a consumer already holds, so a
 * caller that is not the subject can still gate PAT activity on its own committed canonical audit.
 * Evidence must be the Audit-owned exact-call proof correlated to this PAT and User; commit it
 * immediately after that successful Audit write in the same atomic unit.
 */
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
/** Revoke a single live User-owned PAT only after matching Consent evidence is in this D1 unit. */
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
    evidence: { _tag: "UserPAT", sessionId: session.id, occurredAtMs: Option.some(input.current) },
  });

/** Revoke every live PAT under this fresh User decision and its committed Consent evidence. */
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
    evidence: { _tag: "UserPAT", sessionId: session.id, occurredAtMs: Option.none() },
  });

/** Close every approved unclaimed pairing covered by this User's revocation evidence. */
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
    evidence: { _tag: "UserPairing", sessionId: session.id },
  });

/** Apply scheduled policy expiry only to approvals backed by their append-only Consent evidence. */
export const expireApprovedPairings = (current: number): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE state = 'approved_awaiting_claim'
        AND expires_at_ms <= ?`,
      params: [current],
    },
    evidence: { _tag: "ExpiredPairing" },
  });

/** Apply fixed-lifetime expiry without letting successful use extend the committed instant. */
export const expireFixedPATs = (current: number): OwnedStatement =>
  protectPATRevocationStatement({
    statement: {
      sql: `UPDATE pats SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms <= ?`,
      params: [current, current],
    },
    evidence: { _tag: "ExpiredPAT" },
  });

/** Reclaim anonymous metadata without deleting approved User-bound grant evidence. */
export const sweepUnapprovedPairings = ({
  current,
  limit,
}: Readonly<{ current: number; limit: number }>): OwnedStatement => ({
  sql: `DELETE FROM pat_pairings WHERE id IN (
    SELECT id FROM pat_pairings WHERE state = 'pending_approval' AND user_id IS NULL
    AND created_at_ms <= ? ORDER BY created_at_ms LIMIT ?)`,
  params: [current - pairingMilliseconds, limit],
});

export const sweepPairingAdmission = ({
  current,
  limit,
}: Readonly<{ current: number; limit: number }>): OwnedStatement => ({
  sql: `DELETE FROM pat_pairing_admission WHERE source_digest IN (
    SELECT source_digest FROM pat_pairing_admission WHERE window_start_ms <= ?
    ORDER BY window_start_ms LIMIT ?)`,
  params: [current - pairingMilliseconds * 2, limit],
});

export const sweepPairingReviews = ({
  current,
  limit,
}: Readonly<{ current: number; limit: number }>): OwnedStatement => ({
  sql: `DELETE FROM pat_review_attempts WHERE id IN (
    SELECT id FROM pat_review_attempts WHERE occurred_at_ms <= ?
    ORDER BY occurred_at_ms LIMIT ?)`,
  params: [current - pairingMilliseconds * 2, limit],
});

/** Reserve bounded anonymous source capacity before persisting a PATPairing proof digest. */
export const admitPairingSource = ({
  sourceDigest,
  current,
}: Readonly<{ sourceDigest: Uint8Array; current: number }>): OwnedStatement => ({
  sql: `INSERT INTO pat_pairing_admission (source_digest,window_start_ms,started_count)
    SELECT ?,?,1 WHERE (SELECT count(*) FROM pat_pairings WHERE created_at_ms > ?) < ?
    ON CONFLICT(source_digest) DO UPDATE SET
      window_start_ms = CASE WHEN window_start_ms <= ? THEN excluded.window_start_ms ELSE window_start_ms END,
      started_count = CASE WHEN window_start_ms <= ? THEN 1 ELSE started_count + 1 END
    WHERE (window_start_ms <= ? OR started_count < ?)
      AND (SELECT count(*) FROM pat_pairings WHERE created_at_ms > ?) < ?`,
  params: [
    sourceDigest,
    current,
    current - pairingMilliseconds,
    maxPairingsPerWindow,
    current - pairingMilliseconds,
    current - pairingMilliseconds,
    current - pairingMilliseconds,
    maxPairingsPerSource,
    current - pairingMilliseconds,
    maxPairingsPerWindow,
  ],
});

/** Persist only the private-device-code digest when anonymous source admission succeeded. */
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

/** Bound public-code review attempts per WebSession without granting pairing authority. */
export const admitPairingReview = (
  input: Readonly<{
    id: string;
    sessionId: string;
    current: number;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_review_attempts (id,session_id,occurred_at_ms)
    SELECT ?,?,? WHERE (SELECT count(*) FROM pat_review_attempts WHERE session_id = ? AND occurred_at_ms > ?) < ?`,
  params: [
    input.id,
    input.sessionId,
    input.current,
    input.sessionId,
    input.current - pairingMilliseconds,
    maximumReviewAttempts,
  ],
});

/** Record a failed private-device-code proof only for the still-matching pairing state. */
export const recordWrongPairingProof = (
  input: Readonly<{ attempts: number; pairingId: string; state: string; previous: number }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET wrong_attempts = ? WHERE id = ? AND state = ? AND wrong_attempts = ?`,
  params: [input.attempts, input.pairingId, input.state, input.previous],
});

/** Persist backoff for the specific pairing state; polling cannot change grant authority. */
export const slowPairingPoll = (
  input: Readonly<{ seconds: number; pairingId: string; state: string }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET minimum_poll_seconds = ? WHERE id = ? AND state = ?`,
  params: [input.seconds, input.pairingId, input.state],
});

/** Record a pending poll only before approval and only if the observed poll timestamp is current. */
export const recordPendingPoll = (
  input: Readonly<{ current: number; pairingId: string; lastPoll: Option.Option<number> }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET last_poll_at_ms = ? WHERE id = ?
    AND state = 'pending_approval' AND last_poll_at_ms ${Option.isSome(input.lastPoll) ? "= ?" : "IS NULL"} AND expires_at_ms > ?`,
  params: [
    input.current,
    input.pairingId,
    ...(Option.isSome(input.lastPoll) ? [input.lastPoll.value] : []),
    input.current,
  ],
});

/** Mint only from the consumed pairing; the raw bearer never enters persistence. */
export const insertClaimedPAT = (
  input: Readonly<{
    patId: string;
    shortId: string;
    bearerDigest: Uint8Array;
    approvedAt: number;
    current: number;
    expires: number;
    pairingId: string;
    userId: string;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
    created_at_ms,issued_at_ms,expires_at_ms,pairing_id)
    SELECT ?,user_id,?,?,recipient_label,scopes_json,lifetime_days,?,?,?,id
    FROM pat_pairings WHERE id = ? AND state = 'claimed' AND user_id = ? AND changes() = 1`,
  params: [
    input.patId,
    input.shortId,
    input.bearerDigest,
    input.approvedAt,
    input.current,
    input.expires,
    input.pairingId,
    input.userId,
  ],
});

const liveCredentialPredicate = `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`;

/** The live bearer, lifetime, and Consent decision without a scope clause; classification only. */
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
    subject: { _tag: "Owner", column: "pats.user_id" },
    requirement: "unrevoked",
  });

/** Guard protected D1 work with the exact live bearer, Consent, and scope decision. */
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

/** Load the bounded active grants for one User, excluding all credential and terminal-state material. */
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

/** Prepare safe User-owned metadata and its decoder; the caller commits its audit before disclosure. */
export const preparePATMetadata = (
  input: Readonly<{
    userId: string;
    current: number;
    session: Option.Option<FreshSessionSubject>;
  }>
): Readonly<{
  statement: OwnedStatement;
  decode: (rows: unknown) => Effect.Effect<
    {
      readonly data: ActivePATList;
      readonly next: ReadonlyArray<never>;
    },
    Unavailable
  >;
}> => ({ statement: patMetadataQuery(input), decode: (rows) => patMetadataResponseFromRows(rows) });

/** Final statement for a guarded PAT transition; a skipped prerequisite aborts the whole D1 batch. */
export const patAtomicAssertion = `INSERT INTO pat_atomic_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** Reject automatic expiry evidence without its corresponding PAT or pairing transition. */
export const patExpiryCompletion = (current: number): OwnedStatement => {
  const evidence = expiredPATConsentIdentities(current);
  return {
    sql: `INSERT INTO pat_atomic_assertion (id, accepted)
      SELECT 1, CASE WHEN NOT EXISTS (
        SELECT 1 FROM (${evidence.sql}) r JOIN pats p ON p.id = r.id
        WHERE p.revoked_at_ms IS NULL
      ) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`,
    params: evidence.params,
  };
};
/** Abort the expiry unit if matching unclaimed-pairing evidence has no terminal transition. */
export const pairingExpiryCompletion = (current: number): OwnedStatement => {
  const evidence = expiredPairingConsentIdentities(current);
  return {
    sql: `INSERT INTO pat_atomic_assertion (id, accepted)
      SELECT 1, CASE WHEN NOT EXISTS (
        SELECT 1 FROM (${evidence.sql}) r JOIN pat_pairings p ON p.id = r.id
        WHERE p.state = 'approved_awaiting_claim'
      ) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`,
    params: evidence.params,
  };
};

/** A revoke-all may succeed with no grants, but cannot leave any active User-owned grant behind. */
export const patRevokeAllCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
) AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** Historical ownership only, for Audit attribution; never establishes live PAT authority. */
export const patOwnershipQuery = (
  input: Readonly<{ patId: string; userId: string }>
): OwnedStatement => ({
  sql: "SELECT 1 FROM pats WHERE id = ? AND user_id = ?",
  params: [input.patId, input.userId],
});

/** Resolve only id for one User-owned short id; lifecycle and the atomic changes guard remain the caller’s obligation. */
export const patIdentityQuery = (
  input: Readonly<{ userId: string; shortId: string }>
): OwnedStatement => ({
  sql: "SELECT id FROM pats WHERE user_id = ? AND short_id = ?",
  params: [input.userId, input.shortId],
});

/** Select only safe grant references still live for one User's revocation; no bearer verifier escapes. */
export const revocablePATGrants = (
  input: Readonly<{ userId: string; current: number; shortId: Option.Option<string> }>
): PATGrantSelection => ({
  _tag: "PATGrants",
  statement: {
    sql: `SELECT id,user_id,request_id,pairing_id FROM pats WHERE user_id = ?
    AND revoked_at_ms IS NULL AND expires_at_ms > ? ${Option.isSome(input.shortId) ? "AND short_id = ?" : ""}`,
    params: [input.userId, input.current, ...Option.toArray(input.shortId)],
  },
});

/** Select approved unclaimed grants for one User; the caller's fresh decision is guarded in its evidence write. */
export const revocablePairingGrants = (userId: string): PairingGrantSelection => ({
  _tag: "PairingGrants",
  statement: {
    sql: "SELECT id,user_id FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'",
    params: [userId],
  },
});

/** Select the oldest bounded expired grants for symmetric policy evidence in the caller's D1 unit. */
export const expiredPATGrants = (
  input: Readonly<{ current: number; limit: number }>
): PATGrantSelection => ({
  _tag: "PATGrants",
  statement: {
    sql: `SELECT id,user_id,request_id,pairing_id FROM pats WHERE revoked_at_ms IS NULL
    AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?`,
    params: [input.current, input.limit],
  },
});

/** Select the oldest bounded unclaimed approvals at their fixed bootstrap deadline. */
export const expiredPairingGrants = (
  input: Readonly<{ current: number; limit: number }>
): PairingGrantSelection => ({
  _tag: "PairingGrants",
  statement: {
    sql: `SELECT id,user_id FROM pat_pairings WHERE state = 'approved_awaiting_claim'
    AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?`,
    params: [input.current, input.limit],
  },
});
