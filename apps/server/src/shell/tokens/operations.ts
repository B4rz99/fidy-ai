import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ActivePATMetadata,
  type CreateManualPATPayload,
  PATRecipientLabel,
  PATScopes,
  TokenShortId,
} from "~/core/tokens/contract";
import type { UserId } from "~/core/identity/reference";
import { Unavailable } from "~/shell/public-http/contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import {
  type FreshSessionSubject,
  freshSessionExists,
  freshSessionParams,
} from "~/shell/web-session/operations";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";
import type { AuditedPATOperation } from "./contract";

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
}: Readonly<{ session: FreshSessionSubject; input: ManualPATInput }>): OwnedStatement => ({
  sql: `INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
    created_at_ms,issued_at_ms,expires_at_ms,request_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${freshSessionExists}
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`,
  params: [
    input.patId,
    session.userId,
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
    session.userId,
    session.userId,
    input.current,
    maxActivePATs,
    session.userId,
    input.current - issuanceWindowMilliseconds,
    maxIssuancesPerUserWindow,
  ],
});

type ApprovalInput = Readonly<{ pairingId: string; current: number; expires: number }>;
/** Bind an approved PATPairing to its reviewed User before the initiating client claims it. */
export const approvePairingGrant = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: ApprovalInput }>): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'approved_awaiting_claim', user_id = ?, approved_at_ms = ?, pat_expires_at_ms = ?
    WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND ${freshSessionExists}
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)`,
  params: [
    session.userId,
    input.current,
    input.expires,
    input.pairingId,
    input.current,
    ...freshSessionParams({ session, time: input.current }),
    session.userId,
  ],
});

/** Consume a single User-bound PATPairing approval under current Consent and issuance limits. */
export const claimPairingGrant = (
  input: Readonly<{ pairingId: string; userId: string; current: number }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'claimed' WHERE id = ? AND state = 'approved_awaiting_claim'
    AND user_id = ? AND expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pat_pairings.user_id)
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`,
  params: [
    input.pairingId,
    input.userId,
    input.current,
    input.userId,
    input.current,
    maxActivePATs,
    input.userId,
    input.current - issuanceWindowMilliseconds,
    maxIssuancesPerUserWindow,
  ],
});

type PATSubject = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
/** One live-authority gate over the `pats` table: its table, predicate, and bindings. */
export type PATAuthority = Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
const liveCredentialPredicate = `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
  AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pats.user_id)`;

/**
 * The live bearer, lifetime, and Consent decision without any scope clause. Only a classification
 * read: protected work always rechecks the exact required scope through `livePATAuthority`.
 */
export const livePATCredential = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => ({
  table: "pats",
  predicate: liveCredentialPredicate,
  bindings: [subject.patId, subject.userId, subject.digest, current],
});

/** Guard protected D1 work with the same live bearer and Consent decision as PAT use. */
export const livePATAuthority = ({
  subject,
  current,
}: Readonly<{ subject: PATSubject; current: number }>): PATAuthority => ({
  table: "pats",
  predicate: `${liveCredentialPredicate}
    AND ${Option.isSome(subject.requiredScope) ? "EXISTS (SELECT 1 FROM json_each(pats.scopes_json) WHERE value = ?)" : "0"}`,
  bindings: [
    subject.patId,
    subject.userId,
    subject.digest,
    current,
    ...Option.toArray(subject.requiredScope),
  ],
});

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
 * Canonical mutations whose successful canonical audit row gates PAT activity. Reads advance
 * activity through `recordLivePATUse` instead, so the closed set stays mutation-only.
 */
export type AuditedPATMutation = Extract<
  AuditedPATOperation,
  | "ingestion.submitForExtraction"
  | "transactions.createTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.updateTransaction"
>;

type AuditedUseInput = Readonly<{
  auditId: string;
  current: number;
  operation: AuditedPATMutation;
}>;
/** Advance PAT activity only after the matching successful canonical audit committed in this D1 unit. */
export const recordAuditedPATUse = ({
  subject,
  input,
}: Readonly<{ subject: PATSubject; input: AuditedUseInput }>): OwnedStatement =>
  recordAuditedPATUseFromAuthority({
    authority: livePATAuthority({ subject, current: input.current }),
    input,
  });

/**
 * The same activity advance built from the exact live-authority gate a consumer already holds, so a
 * caller that is not the subject can still gate PAT activity on its own committed canonical audit.
 */
export const recordAuditedPATUseFromAuthority = ({
  authority,
  input,
}: Readonly<{ authority: PATAuthority; input: AuditedUseInput }>): OwnedStatement => ({
  sql: `UPDATE pats SET last_used_at_ms = ? WHERE ${authority.predicate} AND changes() = 1
    AND EXISTS (SELECT 1 FROM pat_audit WHERE id = ? AND user_id = pats.user_id
    AND pat_id = pats.id AND operation = ? AND outcome = 'accepted')`,
  params: [input.current, ...authority.bindings, input.auditId, input.operation],
});

type RevokeOneInput = Readonly<{ shortId: string; current: number }>;
/** Revoke a single live User-owned PAT only after matching Consent evidence is in this D1 unit. */
export const revokeOnePAT = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: RevokeOneInput }>): OwnedStatement => ({
  sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NULL
    AND expires_at_ms > ? AND ${freshSessionExists} AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
    AND r.session_id = ? AND r.occurred_at_ms = ?)`,
  params: [
    input.current,
    session.userId,
    input.shortId,
    input.current,
    ...freshSessionParams({ session, time: input.current }),
    session.id,
    input.current,
  ],
});

/** Revoke every live PAT under this fresh User decision and its committed Consent evidence. */
export const revokeEveryPAT = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL
    AND expires_at_ms > ? AND ${freshSessionExists}
    AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id AND r.session_id = ?)`,
  params: [
    current,
    session.userId,
    current,
    ...freshSessionParams({ session, time: current }),
    session.id,
  ],
});

/** Close every approved unclaimed pairing covered by this User's revocation evidence. */
export const revokeEveryPairing = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE user_id = ?
    AND state = 'approved_awaiting_claim' AND ${freshSessionExists}
    AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pairing_id = pat_pairings.id AND r.session_id = ?)`,
  params: [session.userId, ...freshSessionParams({ session, time: current }), session.id],
});

/** Apply scheduled policy expiry only to approvals backed by their append-only Consent evidence. */
export const expireApprovedPairings = (current: number): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE state = 'approved_awaiting_claim'
    AND expires_at_ms <= ? AND EXISTS (SELECT 1 FROM pat_revocation_consents r
    WHERE r.pairing_id = pat_pairings.id AND r.policy_reason = 'pat-approved-unclaimed-expiry')`,
  params: [current],
});

/** Apply fixed-lifetime expiry without letting successful use extend the committed instant. */
export const expireFixedPATs = (current: number): OwnedStatement => ({
  sql: `UPDATE pats SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms <= ?
    AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
    AND r.policy_reason = 'pat-fixed-lifetime-expiry')`,
  params: [current, current],
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

type AuditTime = Readonly<{ id: string; current: number }>;

type TransitionInput = AuditTime &
  Readonly<{
    operation: "pats.approvePATPairing" | "pats.createManualPAT";
    patId: Option.Option<string>;
  }>;
/** A successful approval or issuance is accounted for only when its preceding owner write succeeded. */
export const recordSessionPATTransition = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: TransitionInput }>): OwnedStatement =>
  Option.isNone(input.patId)
    ? {
        sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,?,'accepted',? WHERE changes() = 1`,
        params: [input.id, session.userId, session.id, input.operation, input.current],
      }
    : {
        sql: `INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,?,?,'accepted',? WHERE changes() = 1`,
        params: [
          input.id,
          session.userId,
          session.id,
          input.patId.value,
          input.operation,
          input.current,
        ],
      };

/** The consumed pairing and its minted bearer must both exist before a claim is audited. */
export const recordClaimedPAT = (
  input: AuditTime & Readonly<{ userId: string; patId: string }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.claim','accepted',? WHERE changes() = 1`,
  params: [input.id, input.userId, input.patId, input.current],
});

/** Account for PAT listing only while the same User-owned WebSession remains live. */
export const recordPATList = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: AuditTime }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.listPATs','accepted',? WHERE EXISTS (SELECT 1 FROM web_sessions
    WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)`,
  params: [
    input.id,
    session.userId,
    session.id,
    input.current,
    session.id,
    session.userId,
    input.current,
    input.current,
    session.userId,
  ],
});

type RevokeAuditInput = AuditTime & Readonly<{ shortId: string }>;
/** Link the exact revoked PAT to its User's audit in the same atomic lifecycle unit. */
export const recordOnePATRevocation = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: RevokeAuditInput }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,id,'pats.revokePAT','accepted',? FROM pats
    WHERE user_id = ? AND short_id = ? AND changes() = 1`,
  params: [input.id, session.userId, session.id, input.current, session.userId, input.shortId],
});

/** The revoke-all audit is guarded by the same fresh User decision as its PAT transition. */
export const recordAllPATRevocations = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: AuditTime }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.revokeAllPATs','accepted',? WHERE ${freshSessionExists}`,
  params: [
    input.id,
    session.userId,
    session.id,
    input.current,
    ...freshSessionParams({ session, time: input.current }),
  ],
});

type CanonicalAuditInput = AuditTime &
  Readonly<{
    operation: AuditedPATOperation;
    outcome: "accepted" | "rejected";
    afterOwnerWrite: boolean;
  }>;

/** Audit protected canonical work only while the PAT bearer and User Consent remain live. */
export const recordCanonicalPATWork = ({
  subject,
  input,
}: Readonly<{ subject: PATSubject; input: CanonicalAuditInput }>): OwnedStatement =>
  recordCanonicalPATWorkFromAuthority({
    authority: livePATAuthority({ subject, current: input.current }),
    input,
  });

/**
 * The same canonical PAT audit built from the exact live-authority gate a consumer already holds,
 * so a caller that is not the subject can still account for protected work without restating the
 * bearer, Consent, and scope decision.
 */
export const recordCanonicalPATWorkFromAuthority = ({
  authority,
  input,
}: Readonly<{ authority: PATAuthority; input: CanonicalAuditInput }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT ?,user_id,id,?,?,? FROM pats WHERE ${authority.predicate}
    ${input.afterOwnerWrite ? "AND changes() = 1" : ""}`,
  params: [input.id, input.operation, input.outcome, input.current, ...authority.bindings],
});

/**
 * Audit one rejected canonical PAT call from the exact live-authority gate the caller presented.
 * A consumer that already holds a `PATAuthority` — rather than the subject it was derived from —
 * records the same refusal row without restating the bearer, Consent, and scope decision.
 */
export const recordRejectedPATWork = ({
  authority,
  input,
}: Readonly<{
  authority: PATAuthority;
  input: AuditTime & Readonly<{ operation: AuditedPATOperation }>;
}>): OwnedStatement =>
  recordCanonicalPATWorkFromAuthority({
    authority,
    input: { ...input, afterOwnerWrite: false, outcome: "rejected" },
  });

const activeLimit = 100;
const PATMetadataRow = Schema.Struct({
  short_id: TokenShortId,
  recipient_label: PATRecipientLabel,
  scopes_json: Schema.String,
  created_at_ms: Schema.Finite,
  last_used_at_ms: Schema.NullOr(Schema.Finite),
  expires_at_ms: Schema.Finite,
});
const queryUnavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "PAT metadata is temporarily unavailable. Retry later.",
    },
    next: [],
  });

/** One bounded PAT metadata query, optionally rechecking its web caller at protected D1 work. */
export const patMetadataQuery = ({
  userId,
  current,
  session,
}: Readonly<{
  userId: string;
  current: number;
  session: Option.Option<FreshSessionSubject>;
}>): OwnedStatement => ({
  sql: `SELECT short_id,recipient_label,scopes_json,created_at_ms,last_used_at_ms,expires_at_ms
    FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pats.user_id)
    ${
      Option.isSome(session)
        ? `AND EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?
      AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`
        : ""
    }
    ORDER BY created_at_ms DESC LIMIT ${activeLimit + 1}`,
  params: [
    userId,
    current,
    ...(Option.isSome(session) ? [session.value.id, session.value.userId, current, current] : []),
  ],
});

const decodeMetadata = (
  row: typeof PATMetadataRow.Type
): Effect.Effect<ActivePATMetadata, Schema.SchemaError> =>
  Effect.gen(function* () {
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(row.scopes_json);
    return yield* Schema.decodeEffect(Schema.toType(ActivePATMetadata))({
      shortId: row.short_id,
      recipientLabel: row.recipient_label,
      scopes,
      createdAt: DateTime.makeUnsafe(row.created_at_ms),
      lastUsedAt: Option.map(Option.fromNullishOr(row.last_used_at_ms), DateTime.makeUnsafe),
      expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
    });
  });

/** Decode the same bounded metadata projection for both hosted and public Worker callers. */
export const patMetadataResponseFromRows = (
  raw: unknown
): Effect.Effect<
  {
    readonly data: { readonly pats: ReadonlyArray<ActivePATMetadata> };
    readonly next: ReadonlyArray<never>;
  },
  Unavailable
> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PATMetadataRow))(raw);
    if (rows.length > activeLimit) return yield* queryUnavailable();
    const pats = yield* Effect.forEach(rows, decodeMetadata);
    return { data: { pats }, next: [] as const };
  }).pipe(Effect.mapError(queryUnavailable));

/** Load only active, User-owned PAT metadata; malformed or excessive stored rows fail closed. */
export const listPATsResponse = (
  userId: UserId
): Effect.Effect<
  {
    readonly data: { readonly pats: ReadonlyArray<ActivePATMetadata> };
    readonly next: ReadonlyArray<never>;
  },
  Unavailable,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const sql = yield* SqlClient.SqlClient;
    const query = patMetadataQuery({ userId, current, session: Option.none() });
    const rows = yield* sql.unsafe<Record<string, unknown>>(query.sql, query.params);
    return yield* patMetadataResponseFromRows(rows);
  }).pipe(Effect.mapError(queryUnavailable));

/** Final statement for a guarded PAT transition; a skipped prerequisite aborts the whole D1 batch. */
export const patAtomicAssertion = `INSERT INTO pat_atomic_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** Reject automatic expiry evidence without its corresponding PAT or pairing transition. */
export const patExpiryCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pat_revocation_consents r JOIN pats p ON p.id = r.pat_id
  WHERE r.policy_reason = 'pat-fixed-lifetime-expiry' AND r.occurred_at_ms = ? AND p.revoked_at_ms IS NULL
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
export const pairingExpiryCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pat_revocation_consents r JOIN pat_pairings p ON p.id = r.pairing_id
  WHERE r.policy_reason = 'pat-approved-unclaimed-expiry' AND r.occurred_at_ms = ?
  AND p.state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** A revoke-all may succeed with no grants, but cannot leave any active User-owned grant behind. */
export const patRevokeAllCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
) AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
