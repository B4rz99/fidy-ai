import { patOwnershipQuery } from "~/shell/tokens/operations";
import { Match } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { sessionOwnershipQuery } from "~/shell/web-session/operations";
import {
  AuditActor,
  type AuditAuthority,
  type AuditCredentialOperation,
  type AuthorizedAuditCall,
  type OwnerAuditCall,
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

const canonicalSessionOperations = new Set<string>([
  "transactions.updateTransactions",
  "ingestion.getReviewWorkspace",
  "ingestion.getReviewItem",
  "ingestion.getReviewMaterial",
  "ingestion.getReviewPageContext",
  "ingestion.applyReviewEdit",
]);

const sessionKind = (operation: AuditCredentialOperation): string => {
  const owner = operation.split(".")[0];

  if (canonicalSessionOperations.has(operation)) return "credential_call";

  if (owner === "ingestion") return "publication";

  const kind = sessionKinds.get(owner ?? "");

  if (kind === undefined) throw new Error(`Unknown audit session owner: ${owner ?? ""}`);

  return kind;
};

const recordKind = (operation: AuditCredentialOperation, pat: boolean): string =>
  pat ? "credential_call" : sessionKind(operation);

const credentialColumn = (kind: string, pat: boolean): ReadonlyArray<string> =>
  kind === "publication" ? [] : [pat ? "pat_id" : "session_id"];

const commitGuard = (afterOwnerWrite: boolean): string =>
  afterOwnerWrite ? "AND changes() = 1" : "";

const callerOwnership = (input: OwnerAuditCall): OwnedStatement =>
  Match.valueTags(input.caller, {
    Publication: (): OwnedStatement => ({ sql: "SELECT 1", params: [] }),
    PAT: ({ id }) => patOwnershipQuery({ patId: id, userId: input.userId }),
    WebSession: ({ id }) => sessionOwnershipQuery({ sessionId: id, userId: input.userId }),
  });

const authorityCaller = (authority: AuditAuthority): boolean => authority.table === "pats";

export const ownerCallStatement = (input: OwnerAuditCall): OwnedStatement => {
  const { operation, when, caller } = input;
  const isPat = AuditActor.$is("PAT")(caller);

  const kind = recordKind(operation, isPat);
  const credential = credentialColumn(kind, isPat);

  const credentialValues = Match.valueTags(caller, {
    Publication: (): ReadonlyArray<string> => [],
    PAT: ({ id }) => credential.map(() => id),
    WebSession: ({ id }) => credential.map(() => id),
  });

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
      kind === "credential_call" ? acceptedOutcome(input.outcome) : input.outcome,
      input.current,
      ...when.params,
      ...ownership.params,
    ],
  };
};

const oauthAuthorizedCallStatement = (
  input: Omit<AuthorizedAuditCall, "authority"> & {
    authority: Extract<AuditAuthority, { table: "oauth_credentials" }>;
  }
): OwnedStatement => {
  const { authority, id, operation, outcome, current, afterOwnerWrite } = input;

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
};

const acceptedOutcome = (outcome: AuthorizedAuditCall["outcome"]): string =>
  outcome === "success" || outcome === "accepted" ? "accepted" : "rejected";

export const authorizedCallStatement = (input: AuthorizedAuditCall): OwnedStatement => {
  const { authority, id, operation, outcome, current, afterOwnerWrite } = input;

  if (authority.table === "oauth_credentials") {
    return oauthAuthorizedCallStatement({ ...input, authority });
  }

  if (authority.table === "hosted_turns" && sessionKind(operation) !== "insight_call") {
    return {
      sql: `INSERT INTO audit_entries(record_type,id,user_id,hosted_turn_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,user_id,id,?,?,? FROM hosted_turns WHERE ${authority.predicate} ${commitGuard(afterOwnerWrite)}`,
      params: [id, operation, acceptedOutcome(outcome), current, ...authority.bindings],
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
    params: [
      kind,
      id,
      operation,
      kind === "credential_call" ? acceptedOutcome(outcome) : outcome,
      current,
      ...authority.bindings,
    ],
  };
};
