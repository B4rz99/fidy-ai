import { Option } from "effect";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import {
  type FreshSessionSubject,
  freshSessionExists,
  freshSessionParams,
} from "~/shell/identity/browser-runtime";
import { livePATAuthority } from "./pat-write";

type PATSubject = Readonly<{ patId: string; userId: string; digest: Uint8Array }>;
type AuditTime = Readonly<{ id: string; current: number }>;

/** A successful approval or issuance is accounted for only when its preceding owner write succeeded. */
export const recordSessionPATTransition = (
  session: FreshSessionSubject,
  input: AuditTime &
    Readonly<{
      operation: "pats.approvePATPairing" | "pats.createManualPAT";
      patId: Option.Option<string>;
    }>
): OwnedStatement =>
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
export const recordPATList = (session: FreshSessionSubject, input: AuditTime): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.listPATs','accepted',? WHERE EXISTS (SELECT 1 FROM web_sessions
    WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)`,
  params: [
    input.id,
    session.user_id,
    session.id,
    input.current,
    session.id,
    session.user_id,
    input.current,
    input.current,
    session.user_id,
  ],
});

/** Link the exact revoked PAT to its User's audit in the same atomic lifecycle unit. */
export const recordOnePATRevocation = (
  session: FreshSessionSubject,
  input: AuditTime & Readonly<{ shortId: string }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,id,'pats.revokePAT','accepted',? FROM pats
    WHERE user_id = ? AND short_id = ? AND changes() = 1`,
  params: [input.id, session.user_id, session.id, input.current, session.user_id, input.shortId],
});

/** The revoke-all audit is guarded by the same fresh User decision as its PAT transition. */
export const recordAllPATRevocations = (
  session: FreshSessionSubject,
  input: AuditTime
): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.revokeAllPATs','accepted',? WHERE ${freshSessionExists}`,
  params: [
    input.id,
    session.user_id,
    session.id,
    input.current,
    ...freshSessionParams(session, input.current),
  ],
});

type CanonicalPATOperation =
  | "categories.listCategories"
  | "transactions.createTransaction"
  | "transactions.listTransactions"
  | "transactions.getTransaction";

/** Audit protected canonical work only while the PAT bearer and User Consent remain live. */
export const recordCanonicalPATWork = (
  subject: PATSubject,
  input: AuditTime &
    Readonly<{
      operation: CanonicalPATOperation;
      outcome: "accepted" | "rejected";
      afterSourceAttestation: boolean;
    }>
): OwnedStatement => {
  const authority = livePATAuthority(subject, input.current);
  return {
    sql: `INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
      SELECT ?,user_id,id,?,?,? FROM pats WHERE ${authority.predicate}
      ${input.afterSourceAttestation ? "AND changes() = 1" : ""}`,
    params: [input.id, input.operation, input.outcome, input.current, ...authority.bindings],
  };
};
