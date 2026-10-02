import { Option } from "effect";
import { authorizedCallStatement } from "./recording";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { protectConsentStatement } from "~/shell/consent/operations";
import type { FreshSessionSubject } from "~/shell/web-session/contract";
import {
  freshSessionExists,
  freshSessionParams,
  liveSessionConditions,
} from "~/shell/web-session/operations";
import type { AuditedPATOperation, PATAuthority } from "~/shell/tokens/operations";

type AuditTime = Readonly<{ id: string; current: number }>;

/** A correlated proof that the PAT row's exact successful canonical call exists. */
export const recordedPATCallProof = ({
  auditId,
  operation,
}: Readonly<{ auditId: string; operation: AuditedPATOperation }>): OwnedStatement => ({
  sql: "SELECT 1 FROM pat_audit WHERE id = ? AND user_id = pats.user_id AND pat_id = pats.id AND operation = ? AND outcome = 'accepted'",
  params: [auditId, operation],
});

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
        params: [input.id, session.user_id, session.id, input.operation, input.current],
      }
    : {
        sql: `INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,?,?,'accepted',? WHERE changes() = 1`,
        params: [
          input.id,
          session.user_id,
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
}: Readonly<{ session: FreshSessionSubject; input: AuditTime }>): OwnedStatement => {
  const sessionGuard = liveSessionConditions({ session, current: input.current });
  return protectConsentStatement({
    statement: {
      sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,'pats.listPATs','accepted',? WHERE ${sessionGuard.sql}`,
      params: [input.id, session.user_id, session.id, input.current, ...sessionGuard.params],
    },
    subject: { _tag: "User", userId: session.user_id },
    requirement: "unrevoked",
  });
};

type RevokeAuditInput = AuditTime & Readonly<{ shortId: string }>;
/** Link the exact revoked PAT to its User's audit in the same atomic lifecycle unit. */
export const recordOnePATRevocation = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: RevokeAuditInput }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,id,'pats.revokePAT','accepted',? FROM pats
    WHERE user_id = ? AND short_id = ? AND changes() = 1`,
  params: [input.id, session.user_id, session.id, input.current, session.user_id, input.shortId],
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
    session.user_id,
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

/**
 * The same canonical PAT audit built from the exact live-authority gate a consumer already holds,
 * so a caller that is not the subject can still account for protected work without restating the
 * bearer, Consent, and scope decision.
 */
export const recordCanonicalPATWork = ({
  authority,
  input,
}: Readonly<{ authority: PATAuthority; input: CanonicalAuditInput }>): OwnedStatement =>
  authorizedCallStatement({ authority, ...input });

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
  recordCanonicalPATWork({
    authority,
    input: { ...input, afterOwnerWrite: false, outcome: "rejected" },
  });
