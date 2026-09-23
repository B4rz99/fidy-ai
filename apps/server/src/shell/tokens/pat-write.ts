import { Option } from "effect";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import {
  type FreshSessionSubject,
  freshSessionExists,
  freshSessionParams,
} from "~/shell/identity/browser-runtime";
import { type CreateManualPATPayload } from "~/core/tokens/model";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";

export const pairingMilliseconds = 600_000;
// One source cannot exhaust this pool under the edge's 60-per-10-second budget.
const maxPairingsPerWindow = 4000;
const maxPairingsPerSource = 20;
const maximumReviewAttempts = 10;
export const maxActivePATs = 100;
export const issuanceWindowMilliseconds = 600_000;
export const maxIssuancesPerUserWindow = 20;

/** Guard one reviewed User-owned manual PAT against stale authority and both issuance budgets. */
export const issueManualPAT = (
  session: FreshSessionSubject,
  input: Readonly<{
    grant: typeof CreateManualPATPayload.Type.grant;
    requestId: string;
    patId: string;
    shortId: string;
    bearerDigest: Uint8Array;
    current: number;
    expires: number;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,
    created_at_ms,issued_at_ms,expires_at_ms,request_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${freshSessionExists}
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < ?
    AND (SELECT count(*) FROM pats WHERE user_id = ? AND issued_at_ms > ?) < ?`,
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
    ...freshSessionParams(session, input.current),
    session.user_id,
    session.user_id,
    input.current,
    maxActivePATs,
    session.user_id,
    input.current - issuanceWindowMilliseconds,
    maxIssuancesPerUserWindow,
  ],
});

/** Bind an approved PATPairing to its reviewed User before the initiating client claims it. */
export const approvePairingGrant = (
  session: FreshSessionSubject,
  input: Readonly<{ pairingId: string; current: number; expires: number }>
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'approved_awaiting_claim', user_id = ?, approved_at_ms = ?, pat_expires_at_ms = ?
    WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND ${freshSessionExists}
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)`,
  params: [
    session.user_id,
    input.current,
    input.expires,
    input.pairingId,
    input.current,
    ...freshSessionParams(session, input.current),
    session.user_id,
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

/** Guard protected D1 work with the same live bearer and Consent decision as PAT use. */
export const livePATAuthority = (
  subject: Readonly<{
    patId: string;
    userId: string;
    digest: Uint8Array;
    requiredScope: Option.Option<CanonicalCapability>;
  }>,
  current: number
): Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}> => ({
  table: "pats",
  predicate: `id = ? AND user_id = ? AND bearer_digest = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pats.user_id)
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
export const recordLivePATUse = (
  subject: Readonly<{
    patId: string;
    userId: string;
    digest: Uint8Array;
    requiredScope: Option.Option<CanonicalCapability>;
  }>,
  current: number
): OwnedStatement => {
  const authority = livePATAuthority(subject, current);
  return {
    sql: `UPDATE pats SET last_used_at_ms = ? WHERE ${authority.predicate}`,
    params: [current, ...authority.bindings],
  };
};

/** Revoke a single live User-owned PAT only after matching Consent evidence is in this D1 unit. */
export const revokeOnePAT = (
  session: FreshSessionSubject,
  input: Readonly<{ shortId: string; current: number }>
): OwnedStatement => ({
  sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NULL
    AND expires_at_ms > ? AND ${freshSessionExists} AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
    AND r.session_id = ? AND r.occurred_at_ms = ?)`,
  params: [
    input.current,
    session.user_id,
    input.shortId,
    input.current,
    ...freshSessionParams(session, input.current),
    session.id,
    input.current,
  ],
});

/** Revoke every live PAT under this fresh User decision and its committed Consent evidence. */
export const revokeEveryPAT = (session: FreshSessionSubject, current: number): OwnedStatement => ({
  sql: `UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL
    AND expires_at_ms > ? AND ${freshSessionExists}
    AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id AND r.session_id = ?)`,
  params: [current, session.user_id, current, ...freshSessionParams(session, current), session.id],
});

/** Close every approved unclaimed pairing covered by this User's revocation evidence. */
export const revokeEveryPairing = (
  session: FreshSessionSubject,
  current: number
): OwnedStatement => ({
  sql: `UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE user_id = ?
    AND state = 'approved_awaiting_claim' AND ${freshSessionExists}
    AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pairing_id = pat_pairings.id AND r.session_id = ?)`,
  params: [session.user_id, ...freshSessionParams(session, current), session.id],
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
export const sweepUnapprovedPairings = (current: number, limit: number): OwnedStatement => ({
  sql: `DELETE FROM pat_pairings WHERE id IN (
    SELECT id FROM pat_pairings WHERE state = 'pending_approval' AND user_id IS NULL
    AND created_at_ms <= ? ORDER BY created_at_ms LIMIT ?)`,
  params: [current - pairingMilliseconds, limit],
});

export const sweepPairingAdmission = (current: number, limit: number): OwnedStatement => ({
  sql: `DELETE FROM pat_pairing_admission WHERE source_digest IN (
    SELECT source_digest FROM pat_pairing_admission WHERE window_start_ms <= ?
    ORDER BY window_start_ms LIMIT ?)`,
  params: [current - pairingMilliseconds * 2, limit],
});

export const sweepPairingReviews = (current: number, limit: number): OwnedStatement => ({
  sql: `DELETE FROM pat_review_attempts WHERE id IN (
    SELECT id FROM pat_review_attempts WHERE occurred_at_ms <= ?
    ORDER BY occurred_at_ms LIMIT ?)`,
  params: [current - pairingMilliseconds * 2, limit],
});

/** Reserve bounded anonymous source capacity before persisting a PATPairing proof digest. */
export const admitPairingSource = (sourceDigest: Uint8Array, current: number): OwnedStatement => ({
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
