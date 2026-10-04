import type { OwnedStatement } from "~/shell/owner-write/contract";
import {
  type AuditQueryCall,
  AuditUnavailable,
  type AuthorizedAuditCall,
  type CanonicalAdmissionRefusal,
  type CanonicalReplayAccess,
  type EmailReplacementEvidence,
  type OwnerAuditCall,
  dailyAuditBudget,
} from "./contract";
import { emailReplacementEvidence } from "~/shell/audit/internal/email-evidence";
import {
  admissionRefusalStatement,
  authorizedCallStatement,
  ownerCallStatement,
  queryCallStatement,
  replayAccessStatement,
} from "~/shell/audit/internal/recording";
import {
  auditDayBindings,
  auditDayCountExpression,
  browserBudgetGuard,
  dailyAuditCount as countDailyCalls,
} from "~/shell/audit/internal/daily-budget";

import * as patEvidence from "~/shell/audit/internal/pat-evidence";

export { dailyAuditBudget, utcDayMilliseconds } from "./contract";

/**
 * Records approved call metadata only while the supplied User-owned credential is live.
 * Commit the returned statement in the canonical unit, after the owner write when
 * `afterOwnerWrite` is true. A skipped guard changes no row and must refuse the unit;
 * never report success without checking the owning unit's completion assertion.
 * Audit chooses the storage projection and enforces its append-only and budget triggers.
 */
export const recordAuthorizedCall = (input: AuthorizedAuditCall): OwnedStatement =>
  authorizedCallStatement(input);

/**
 * Appends fixed metadata only after a subject-scoped owner proof. Commit it with that owner's
 * write and completion assertion; a failed proof must never produce success evidence. The proof
 * supplies no Audit columns or bodies. This does not independently authorize a canonical call.
 */
export const recordOwnerCall = (input: OwnerAuditCall): OwnedStatement => ownerCallStatement(input);

/**
 * Record the found/absent outcome of a canonical query under its live authority in the same
 * snapshot. `missingWhen` is a subject-scoped owner SELECT; no queried content enters evidence.
 */
export const prepareAuditQueryCall = ({
  db,
  missingWhen,
  ...input
}: AuditQueryCall & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = queryCallStatement({ ...input, missingWhen });
  return db.prepare(statement.sql).bind(...statement.params);
};

/** Bind an attributable call to D1 without committing it outside its canonical unit. */
export const prepareAuthorizedAuditCall = ({
  db,
  ...input
}: AuthorizedAuditCall & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = authorizedCallStatement(input);
  return db.prepare(statement.sql).bind(...statement.params);
};

/** Record an authenticated admission refusal without retaining input, key, or error detail. */
export const prepareCanonicalAdmissionRefusal = ({
  db,
  ...input
}: CanonicalAdmissionRefusal & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = admissionRefusalStatement(input);
  return db.prepare(statement.sql).bind(...statement.params);
};

/** Bind current-PAT disclosure evidence and the exact retained response proof in one read/accountability unit. */
export const prepareCanonicalReplayAccess = ({
  db,
  ...input
}: CanonicalReplayAccess & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = replayAccessStatement(input);
  return db.prepare(statement.sql).bind(...statement.params);
};

/** Bind approved credential-replacement evidence to its owner's atomic D1 transition. */
export const prepareEmailReplacementEvidence = ({
  db,
  ...input
}: EmailReplacementEvidence & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = emailReplacementEvidence(input);
  return db.prepare(statement.sql).bind(...statement.params);
};

/**
 * Proof for a PAT-owner activity transition correlated to its subject row. The exact successful
 * call must exist under that PAT and User; compose this SELECT with the credential owner's guard.
 */
export const recordedPATCallProof: typeof patEvidence.recordedPATCallProof = (input) =>
  patEvidence.recordedPATCallProof(input);

/** Exact current-PAT proof for a successfully disclosed retained canonical envelope. */
export const recordedPATReplayCallProof: typeof patEvidence.recordedPATReplayCallProof = (input) =>
  patEvidence.recordedPATReplayCallProof(input);

/** Attribute a successful PAT issuance/approval only after the credential owner's preceding write. */
export const recordSessionPATTransition: typeof patEvidence.recordSessionPATTransition = (input) =>
  patEvidence.recordSessionPATTransition(input);
/** Attribute a pairing claim only after the consumed proof and minted PAT commit in the same unit. */
export const recordClaimedPAT: typeof patEvidence.recordClaimedPAT = (input) =>
  patEvidence.recordClaimedPAT(input);
/** Account for PAT-list access under the exact live User-owned session. */
export const recordPATList: typeof patEvidence.recordPATList = (input) =>
  patEvidence.recordPATList(input);
/** Append revocation evidence naming the exact User-owned PAT just revoked. */
export const recordOnePATRevocation: typeof patEvidence.recordOnePATRevocation = (input) =>
  patEvidence.recordOnePATRevocation(input);
/** Append revoke-all evidence under the same fresh User decision as its credential transition. */
export const recordAllPATRevocations: typeof patEvidence.recordAllPATRevocations = (input) =>
  patEvidence.recordAllPATRevocations(input);
/** Append canonical-call evidence under the exact live authority supplied by the PAT owner. */
export const recordCanonicalPATWork: typeof patEvidence.recordCanonicalPATWork = (input) =>
  patEvidence.recordCanonicalPATWork(input);
/** Append a refused canonical call under the live authority that attempted it. */
export const recordRejectedPATWork: typeof patEvidence.recordRejectedPATWork = (input) =>
  patEvidence.recordRejectedPATWork(input);

/** Classify commit-time Audit budget refusal without returning a raw D1 error or its contents. */
export const refusedByAuditBudget = (cause: unknown): boolean =>
  String(cause).includes("transaction_audit_limit") ||
  String(cause).includes("statement_audit_limit") ||
  String(cause).includes("batch_envelope_limit");

/** Count one explicit User's canonical work without exposing Audit's storage projections or failures. */
export const dailyAuditCount = (
  input: Readonly<{ db: D1Database; userId: string; current: number }>
): Promise<number> =>
  countDailyCalls(input).catch(() => {
    throw new AuditUnavailable();
  });
/** True when a User cannot admit another call under the shared daily budget. */
export const dailyAuditExhausted = (
  input: Readonly<{ db: D1Database; userId: string; current: number }>
): Promise<boolean> => dailyAuditCount(input).then((count) => count >= dailyAuditBudget);
/** Recheck the shared Audit budget inside the indexed canonical child commit, so exhaustion rolls it back. */
export const prepareCanonicalAuditBudgetGuard = ({
  db,
  userId,
  current,
  index,
  operation,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  index: number;
  operation: string;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO canonical_child_guard (child_index,operation,accepted,budget_ok)
    SELECT ?,?,1,CASE WHEN (${auditDayCountExpression}) < ? THEN 1 ELSE 0 END
    ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
      accepted = excluded.accepted, budget_ok = excluded.budget_ok`)
    .bind(index, operation, ...auditDayBindings({ userId, current }), dailyAuditBudget);

/** Recheck a Budget/Insight browser-call budget in the exact indexed canonical child commit. */
export const prepareBrowserAuditBudgetGuard = ({
  db,
  ...input
}: Readonly<{
  db: D1Database;
  owner: "budgets" | "insights";
  userId: string;
  current: number;
  index: number;
  operation: string;
}>): D1PreparedStatement => {
  const statement = browserBudgetGuard(input);
  return db.prepare(statement.sql).bind(...statement.params);
};

/** Bind fixed metadata and a subject-scoped owner proof to the same atomic D1 unit. */
export const prepareOwnerAuditCall = ({
  db,
  ...input
}: OwnerAuditCall & Readonly<{ db: D1Database }>): D1PreparedStatement => {
  const statement = ownerCallStatement(input);
  return db.prepare(statement.sql).bind(...statement.params);
};
