import { patOwnershipQuery } from "~/shell/tokens/operations";
import { Option } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { sessionOwnershipQuery } from "~/shell/web-session/operations";
import type {
  AuditAuthority,
  AuditCredentialOperation,
  AuditQueryCall,
  AuthorizedAuditCall,
  CanonicalAdmissionRefusal,
  CanonicalReplayAccess,
  OwnerAuditCall,
} from "~/shell/audit/contract";

const sessionDestinations = new Map([
  ["transactions", "transaction_audit"],
  ["operations", "transaction_audit"],
  ["categories", "category_audit"],
  ["memory", "memory_audit"],
  ["budgets", "budget_audit"],
  ["dashboard", "dashboard_audit"],
  ["insights", "insight_audit"],
  ["subscription", "pat_audit"],
  ["quota", "pat_audit"],
  ["connections", "pat_audit"],
  ["recurring", "pat_audit"],
]);
const sessionDestination = (operation: AuditCredentialOperation): string => {
  const owner = operation.split(".")[0];
  if (owner === "ingestion") {
    if (
      operation === "ingestion.resolveNeedsReviewItem" ||
      operation === "ingestion.skipNeedsReviewItem" ||
      operation === "ingestion.abandonStatementSubmission"
    ) {
      return "statement_clarification_audit";
    }
    return operation === "ingestion.listNeedsReviewItems"
      ? "statement_review_audit"
      : "statement_submission_audit";
  }
  return Option.getOrThrow(Option.fromUndefinedOr(sessionDestinations.get(owner ?? "")));
};
const destination = (operation: AuditCredentialOperation, pat: boolean): string =>
  pat ? "pat_audit" : sessionDestination(operation);
const credentialColumn = (table: string, pat: boolean): ReadonlyArray<string> =>
  table === "statement_submission_audit" ||
  table === "statement_review_audit" ||
  table === "statement_clarification_audit"
    ? []
    : [pat ? "pat_id" : "session_id"];
const outcomeColumns = (table: string, outcome: string): ReadonlyArray<string> =>
  table === "category_audit" && outcome === "success" ? [] : ["outcome"];
const commitGuard = (afterOwnerWrite: boolean): string =>
  afterOwnerWrite ? "AND changes() = 1" : "";
const callerOwnership = (input: OwnerAuditCall): OwnedStatement => {
  switch (input.caller._tag) {
    case "Publication":
      return { sql: "SELECT 1", params: [] };
    case "PAT":
      return patOwnershipQuery({ patId: input.caller.id, userId: input.userId });
    case "WebSession":
      return sessionOwnershipQuery({ sessionId: input.caller.id, userId: input.userId });
  }
};
const authorityCaller = (authority: AuditAuthority): boolean => authority.table === "pats";

const oauthAdmissionStatement = ({
  authority,
  id,
  operation,
  current,
  outcome,
}: CanonicalAdmissionRefusal &
  Readonly<{
    authority: AuditAuthority & { table: "oauth_access_credentials" };
    outcome: "accepted" | "rejected";
  }>): OwnedStatement => ({
  sql: `INSERT INTO pat_audit (id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,?,?,?,? FROM ${authority.table} WHERE ${authority.predicate}`,
  params: [
    id,
    authority.attribution.userId,
    authority.attribution.connectionId,
    authority.attribution.credentialId,
    operation,
    outcome,
    current,
    ...authority.bindings,
  ],
});

/** Admission refusals are canonical metadata, not allowance counters or retained request bodies. */
export const admissionRefusalStatement = ({
  authority,
  id,
  operation,
  current,
}: CanonicalAdmissionRefusal): OwnedStatement =>
  authority.table === "oauth_access_credentials"
    ? oauthAdmissionStatement({ authority, id, operation, current, outcome: "rejected" })
    : {
        sql: `INSERT INTO pat_audit (id,user_id,${authority.table === "pats" ? "pat_id" : "session_id"},operation,outcome,occurred_at_ms) SELECT ?,user_id,id,?,'rejected',? FROM ${authority.table} WHERE ${authority.predicate}`,
        params: [id, operation, current, ...authority.bindings],
      };

/** Records fixed metadata after an owner-scoped existence proof, retaining the owner's atomic guard. */
export const ownerCallStatement = (input: OwnerAuditCall): OwnedStatement => {
  const { operation, when, caller } = input;
  const table = destination(operation, caller._tag === "PAT");
  const credential = credentialColumn(table, caller._tag === "PAT");
  const credentialValues = caller._tag === "Publication" ? [] : credential.map(() => caller.id);
  const outcome = outcomeColumns(table, input.outcome);
  const columns = ["id", "user_id", ...credential, "operation", ...outcome, "occurred_at_ms"];
  const ownership = callerOwnership(input);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map(() => "?").join(", ")}
      WHERE EXISTS (${when.sql}) AND EXISTS (${ownership.sql}) ${commitGuard(input.afterOwnerWrite)}`,
    params: [
      input.id,
      input.userId,
      ...credentialValues,
      operation,
      ...outcome.map(() => input.outcome),
      input.current,
      ...when.params,
      ...ownership.params,
    ],
  };
};

/** Builds the found/absent metadata decision inside the query's live credential snapshot. */
export const queryCallStatement = ({ missingWhen, ...input }: AuditQueryCall): OwnedStatement => {
  const { authority, id, operation, current } = input;
  if (authority.table === "oauth_access_credentials") {
    return {
      sql: `INSERT INTO pat_audit (id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,?,?,CASE WHEN EXISTS (${missingWhen.sql}) THEN 'rejected' ELSE 'accepted' END,?
        FROM ${authority.table} WHERE ${authority.predicate}`,
      params: [
        id,
        authority.attribution.userId,
        authority.attribution.connectionId,
        authority.attribution.credentialId,
        operation,
        ...missingWhen.params,
        current,
        ...authority.bindings,
      ],
    };
  }
  const pat = authorityCaller(authority);
  const table = destination(operation, pat);
  const credential = credentialColumn(table, pat);
  const columns = ["id", "user_id", ...credential, "operation", "outcome", "occurred_at_ms"];
  const values = [
    "?",
    "user_id",
    ...credential.map(() => "id"),
    "?",
    `CASE WHEN EXISTS (${missingWhen.sql}) THEN '${table === "pat_audit" ? "rejected" : "not_found"}' ELSE '${table === "pat_audit" ? "accepted" : "success"}' END`,
    "?",
  ];
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${authority.table} WHERE ${authority.predicate}`,
    params: [id, operation, ...missingWhen.params, current, ...authority.bindings],
  };
};

/** Replay reads get current-credential accountability without restating or reexecuting domain work. */
export const replayAccessStatement = ({
  authority,
  id,
  operation,
  current,
  outcome,
  retainedResponseProof,
}: CanonicalReplayAccess): OwnedStatement =>
  authority.table === "oauth_access_credentials"
    ? oauthAdmissionStatement({
        authority: {
          ...authority,
          predicate: `${authority.predicate} AND EXISTS (${retainedResponseProof.sql})`,
          bindings: [...authority.bindings, ...retainedResponseProof.params],
        },
        id,
        operation,
        current,
        outcome,
      })
    : {
        sql: `INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms) SELECT ?,user_id,id,?,?,? FROM pats WHERE ${authority.predicate} AND EXISTS (${retainedResponseProof.sql})`,
        params: [
          id,
          operation,
          outcome,
          current,
          ...authority.bindings,
          ...retainedResponseProof.params,
        ],
      };

/** Builds evidence under the exact credential gate held by the coordinator. */
export const authorizedCallStatement = (input: AuthorizedAuditCall): OwnedStatement => {
  const { authority, id, operation, outcome, current, afterOwnerWrite } = input;
  if (authority.table === "oauth_access_credentials") {
    return {
      sql: `INSERT INTO pat_audit (id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms)
        SELECT ?,?,?,?,?,?,? FROM ${authority.table} WHERE ${authority.predicate} ${commitGuard(afterOwnerWrite)}`,
      params: [
        id,
        authority.attribution.userId,
        authority.attribution.connectionId,
        authority.attribution.credentialId,
        operation,
        outcome === "accepted" || outcome === "success" ? "accepted" : "rejected",
        current,
        ...authority.bindings,
      ],
    };
  }
  const pat = authorityCaller(authority);
  const table = destination(operation, pat);
  const credential =
    authority.table === "hosted_turns" && table === "insight_audit"
      ? ["hosted_turn_id"]
      : credentialColumn(table, pat);
  const recordedOutcome = outcomeColumns(table, outcome);
  const columns = [
    "id",
    "user_id",
    ...credential,
    "operation",
    ...recordedOutcome,
    "occurred_at_ms",
  ];
  const values = [
    "?",
    "user_id",
    ...credential.map(() => "id"),
    "?",
    ...recordedOutcome.map(() => "?"),
    "?",
  ];
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${authority.table} WHERE ${authority.predicate} ${commitGuard(afterOwnerWrite)}`,
    params: [id, operation, ...recordedOutcome.map(() => outcome), current, ...authority.bindings],
  };
};
