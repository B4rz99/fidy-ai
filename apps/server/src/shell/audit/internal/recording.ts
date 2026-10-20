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

const sessionKinds = new Map([
  ["consent", "credential_call"],
  ["privacy", "credential_call"],
  ["transactions", "session_call"],
  ["operations", "session_call"],
  ["categories", "session_call"],
  ["memory", "session_call"],
  ["budgets", "session_call"],
  ["dashboard", "session_call"],
  ["insights", "insight_call"],
  ["subscription", "credential_call"],
  ["quota", "credential_call"],
  ["connections", "credential_call"],
  ["recurring", "credential_call"],
  ["recurringPlans", "credential_call"],
]);
const reviewOperations = new Set<string>([
  "ingestion.getReviewWorkspace",
  "ingestion.getReviewItem",
  "ingestion.getReviewMaterial",
  "ingestion.getReviewSuggestions",
  "ingestion.applyReviewEdit",
]);
const sessionKind = (operation: AuditCredentialOperation): string => {
  const owner = operation.split(".")[0];
  if (reviewOperations.has(operation)) return "credential_call";
  if (owner === "ingestion") return "publication";
  return Option.getOrThrow(Option.fromUndefinedOr(sessionKinds.get(owner ?? "")));
};
const recordKind = (operation: AuditCredentialOperation, pat: boolean): string =>
  pat ? "credential_call" : sessionKind(operation);
const credentialColumn = (kind: string, pat: boolean): ReadonlyArray<string> =>
  kind === "publication" ? [] : [pat ? "pat_id" : "session_id"];
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
    authority: AuditAuthority & { table: "oauth_credentials" };
    outcome: "accepted" | "rejected";
  }>): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,?,?,? FROM ${authority.table} WHERE ${authority.predicate}`,
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
  authority.table === "oauth_credentials"
    ? oauthAdmissionStatement({ authority, id, operation, current, outcome: "rejected" })
    : {
        sql: `INSERT INTO audit_entries(record_type,id,user_id,${authority.table === "pats" ? "pat_id" : "session_id"},operation,outcome,occurred_at_ms) SELECT 'credential_call',?,user_id,id,?,'rejected',? FROM ${authority.table} WHERE ${authority.predicate}`,
        params: [id, operation, current, ...authority.bindings],
      };

/** Records fixed metadata after an owner-scoped existence proof, retaining the owner's atomic guard. */
export const ownerCallStatement = (input: OwnerAuditCall): OwnedStatement => {
  const { operation, when, caller } = input;
  const kind = recordKind(operation, caller._tag === "PAT");
  const credential = credentialColumn(kind, caller._tag === "PAT");
  const credentialValues = caller._tag === "Publication" ? [] : credential.map(() => caller.id);
  const columns = [
    "record_type",
    "id",
    "user_id",
    ...credential,
    "operation",
    "outcome",
    "occurred_at_ms",
  ];
  const ownership = callerOwnership(input);
  return {
    sql: `INSERT INTO audit_entries (${columns.join(", ")}) SELECT ${columns.map(() => "?").join(", ")}
      WHERE EXISTS (${when.sql}) AND EXISTS (${ownership.sql}) ${commitGuard(input.afterOwnerWrite)}`,
    params: [
      kind,
      input.id,
      input.userId,
      ...credentialValues,
      operation,
      input.outcome,
      input.current,
      ...when.params,
      ...ownership.params,
    ],
  };
};

/** Builds the found/absent metadata decision inside the query's live credential snapshot. */
export const queryCallStatement = ({ missingWhen, ...input }: AuditQueryCall): OwnedStatement => {
  const { authority, id, operation, current } = input;
  if (authority.table === "oauth_credentials") {
    return {
      sql: `INSERT INTO audit_entries(record_type,id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,?,CASE WHEN EXISTS (${missingWhen.sql}) THEN 'rejected' ELSE 'accepted' END,?
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
  const kind = recordKind(operation, pat);
  const credential = credentialColumn(kind, pat);
  const columns = [
    "record_type",
    "id",
    "user_id",
    ...credential,
    "operation",
    "outcome",
    "occurred_at_ms",
  ];
  const values = [
    "?",
    "?",
    "user_id",
    ...credential.map(() => "id"),
    "?",
    `CASE WHEN EXISTS (${missingWhen.sql}) THEN '${kind === "credential_call" ? "rejected" : "not_found"}' ELSE '${kind === "credential_call" ? "accepted" : "success"}' END`,
    "?",
  ];
  return {
    sql: `INSERT INTO audit_entries (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${authority.table} WHERE ${authority.predicate}`,
    params: [kind, id, operation, ...missingWhen.params, current, ...authority.bindings],
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
  authority.table === "oauth_credentials"
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
        sql: `INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,user_id,id,?,?,? FROM pats WHERE ${authority.predicate} AND EXISTS (${retainedResponseProof.sql})`,
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
  if (authority.table === "oauth_credentials") {
    return {
      sql: `INSERT INTO audit_entries(record_type,id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,?,?,? FROM ${authority.table} WHERE ${authority.predicate} ${commitGuard(afterOwnerWrite)}`,
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
  const kind = recordKind(operation, pat);
  const credential =
    authority.table === "hosted_turns" &&
    (kind === "insight_call" || operation.startsWith("recurringPlans."))
      ? ["hosted_turn_id"]
      : credentialColumn(kind, pat);
  const columns = [
    "record_type",
    "id",
    "user_id",
    ...credential,
    "operation",
    "outcome",
    "occurred_at_ms",
  ];
  const values = ["?", "?", "user_id", ...credential.map(() => "id"), "?", "?", "?"];
  return {
    sql: `INSERT INTO audit_entries (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${authority.table} WHERE ${authority.predicate} ${commitGuard(afterOwnerWrite)}`,
    params: [kind, id, operation, outcome, current, ...authority.bindings],
  };
};
