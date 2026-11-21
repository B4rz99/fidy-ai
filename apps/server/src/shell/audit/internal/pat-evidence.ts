import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { patIdentityQuery } from "~/shell/tokens/operations";
import { Option } from "effect";
import { authorizedCallStatement } from "./recording";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { FreshSessionSubject } from "~/shell/web-session/contract";
import { freshSessionExists, freshSessionParams } from "~/shell/web-session/operations";
import type { AuditedPATOperation, PATAuthority } from "~/shell/tokens/contract";

type AuditTime = Readonly<{ id: string; current: number }>;

export const recordedPATCallProof = ({
  auditId,
  operation,
}: Readonly<{ auditId: string; operation: AuditedPATOperation }>): OwnedStatement => ({
  sql: "SELECT 1 FROM audit_entries WHERE record_type='credential_call' AND id = ? AND user_id = pats.user_id AND pat_id = pats.id AND operation = ? AND outcome = 'accepted'",
  params: [auditId, operation],
});

export const recordedPATReplayCallProof = ({
  auditId,
  operation,
}: Readonly<{ auditId: string; operation: CanonicalOperationId }>): OwnedStatement => ({
  sql: "SELECT 1 FROM audit_entries WHERE record_type='credential_call' AND id = ? AND user_id = pats.user_id AND pat_id = pats.id AND operation = ? AND outcome = 'accepted'",
  params: [auditId, operation],
});

type TransitionInput = AuditTime &
  Readonly<{
    operation: "pats.approvePATPairing" | "pats.createManualPAT";
    patId: Option.Option<string>;
  }>;

export const recordSessionPATTransition = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: TransitionInput }>): OwnedStatement =>
  Option.isNone(input.patId)
    ? {
        sql: `INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,'accepted',? WHERE changes() = 1`,
        params: [input.id, session.user_id, session.id, input.operation, input.current],
      }
    : {
        sql: `INSERT INTO audit_entries(record_type,id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,?,'accepted',? WHERE changes() = 1`,
        params: [
          input.id,
          session.user_id,
          session.id,
          input.patId.value,
          input.operation,
          input.current,
        ],
      };

export const recordClaimedPAT = (
  input: AuditTime & Readonly<{ userId: string; patId: string }>
): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,'pats.claim','accepted',? WHERE changes() = 1`,
  params: [input.id, input.userId, input.patId, input.current],
});

export const recordPATList = ({
  authority,
  input,
}: Readonly<{
  authority: Readonly<{
    table: "web_sessions" | "hosted_turns";
    predicate: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }>;
  input: AuditTime;
}>): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,${authority.table === "hosted_turns" ? "hosted_turn_id" : "session_id"},operation,outcome,occurred_at_ms) SELECT 'credential_call',?,user_id,id,'pats.listPATs','accepted',? FROM ${authority.table} WHERE ${authority.predicate}`,
  params: [input.id, input.current, ...authority.bindings],
});

type RevokeAuditInput = AuditTime & Readonly<{ shortId: string }>;

export const recordOnePATRevocation = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: RevokeAuditInput }>): OwnedStatement => {
  const selected = patIdentityQuery({ userId: session.user_id, shortId: input.shortId });

  return {
    sql: `INSERT INTO audit_entries(record_type,id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,id,'pats.revokePAT','accepted',? FROM (${selected.sql}) WHERE changes() = 1`,
    params: [input.id, session.user_id, session.id, input.current, ...selected.params],
  };
};

export const recordAllPATRevocations = ({
  session,
  input,
}: Readonly<{ session: FreshSessionSubject; input: AuditTime }>): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,'pats.revokeAllPATs','accepted',? WHERE ${freshSessionExists}`,
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

export const recordCanonicalPATWork = ({
  authority,
  input,
}: Readonly<{ authority: PATAuthority; input: CanonicalAuditInput }>): OwnedStatement =>
  authorizedCallStatement({ authority, ...input });

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
