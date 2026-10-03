import { Data, Struct } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { AuditLogEntry } from "~/core/audit/contract";
/** The closed canonical vocabulary shared with credential accountability. */
export type AuditCredentialOperation =
  | "budgets.createBudget"
  | "budgets.updateBudget"
  | "budgets.deleteBudget"
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus"
  | "categories.createKeywordRule"
  | "categories.deleteKeywordRule"
  | "categories.listCategories"
  | "categories.listKeywordRules"
  | "categories.updateKeywordRule"
  | "dashboard.getDashboard"
  | "dashboard.getDashboardView"
  | "dashboard.listDashboardCatalog"
  | "dashboard.applyDashboardEdit"
  | "ingestion.enableEmailForwarding"
  | "ingestion.getEmailForwarding"
  | "ingestion.getStatementSubmission"
  | "ingestion.listNeedsReviewItems"
  | "ingestion.submitForExtraction"
  | "insights.listPendingInsights"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight"
  | "recurring.listRecurringSeries"
  | "memory.forget"
  | "memory.recall"
  | "memory.remember"
  | "memory.revise"
  | "operations.executeAtomicBatch"
  | "subscription.getSubscriptionStatus"
  | "subscription.listSubscriptionOffers"
  | "transactions.createTransaction"
  | "transactions.getTransaction"
  | "transactions.linkTransactions"
  | "transactions.listTransactions"
  | "transactions.searchTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.updateTransaction";
/** Supporting evidence is retained only for these credential-free statement projections. */
export type AuditPublicationOperation =
  | "ingestion.submitForExtraction"
  | "ingestion.listNeedsReviewItems";
/** The shared stable-User daily canonical-call budget enforced at commit time. */
export const dailyAuditBudget = 256;
/** UTC-day width used by canonical admission, in milliseconds. */
export const utcDayMilliseconds = 86400000;

/** A live, User-scoped credential gate supplied by the credential owner; Audit never resolves identity. */
export type AuditAuthority = Readonly<{
  table: "web_sessions" | "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

type AcceptedSessionOperation = Extract<
  AuditCredentialOperation,
  `${"budgets" | "dashboard" | "insights" | "subscription" | "recurring"}.${string}`
>;
type CategoryOperation = Extract<AuditCredentialOperation, `categories.${string}`>;
type LegacySessionOperation = Exclude<
  AuditCredentialOperation,
  AcceptedSessionOperation | CategoryOperation | "ingestion.listNeedsReviewItems"
>;
type AcceptedOutcome = "accepted" | "rejected";
type LegacyOutcome = "success" | "not_found" | "validation_failed" | "resource_limit";

/** Session evidence preserves each operation owner's closed decision vocabulary. */
type SessionDecision =
  | Readonly<{ operation: LegacySessionOperation; outcome: LegacyOutcome }>
  | Readonly<{ operation: CategoryOperation; outcome: "success" | "validation_failed" }>
  | Readonly<{ operation: "ingestion.listNeedsReviewItems"; outcome: "success" }>;

/** One canonical call's metadata, with outcomes valid for its held credential and operation. */
export type AuthorizedAuditCall = Readonly<{
  id: string;
  current: number;
  afterOwnerWrite: boolean;
}> &
  (
    | Readonly<{
        authority: AuditAuthority;
        operation: AcceptedSessionOperation;
        outcome: AcceptedOutcome;
      }>
    | Readonly<{
        authority: AuditAuthority & { table: "pats" };
        operation: AuditCredentialOperation;
        outcome: AcceptedOutcome;
      }>
    | (Readonly<{ authority: AuditAuthority & { table: "web_sessions" } }> & SessionDecision)
  );

/** Found/absent decisions supported by the query recorder's live credential snapshot. */
export type AuditQueryCall = Readonly<{
  authority: AuditAuthority;
  id: string;
  operation:
    | "transactions.getTransaction"
    | "transactions.listTransactions"
    | "transactions.searchTransactions"
    | "ingestion.getStatementSubmission";
  current: number;
  missingWhen: OwnedStatement;
}>;

/** The acting credential, or supporting publication evidence accounted for by a separate credential row. */
export type AuditActor =
  | Readonly<{ _tag: "WebSession"; id: string }>
  | Readonly<{ _tag: "PAT"; id: string }>
  | Readonly<{ _tag: "Publication" }>;

/**
 * Metadata accompanying an owner's commit proof. `when` is trusted, parameterized owner SQL
 * selecting existence, never external input or Audit persistence. It must include the same User
 * in every User-owned lookup. The statement records no fields from that proof.
 */
export type OwnerAuditCall = Readonly<{
  id: string;
  userId: string;
  current: number;
  when: OwnedStatement;
  afterOwnerWrite: boolean;
}> &
  (
    | Readonly<{
        caller: Exclude<AuditActor, { _tag: "Publication" }>;
        operation: AcceptedSessionOperation;
        outcome: AcceptedOutcome;
      }>
    | Readonly<{
        caller: Extract<AuditActor, { _tag: "PAT" }>;
        operation: AuditCredentialOperation;
        outcome: AcceptedOutcome;
      }>
    | (Readonly<{ caller: Extract<AuditActor, { _tag: "WebSession" }> }> & SessionDecision)
    | Readonly<{
        caller: Extract<AuditActor, { _tag: "Publication" }>;
        operation: AuditPublicationOperation;
        outcome: "success";
      }>
  );

/** Approved credential-replacement evidence, never mailbox content or a proof value. */
export type EmailReplacementEvidence = Readonly<{
  id: string;
  userId: string;
  sessionId: string;
  current: number;
  afterOwnerWrite: boolean;
}> &
  (
    | Readonly<{ operation: "requestEmailReplacement"; outcome: "accepted" }>
    | Readonly<{ operation: "completeEmailReplacement"; outcome: "replaced" }>
    | Readonly<{
        operation: "requestEmailReplacement" | "completeEmailReplacement";
        outcome: "rejected";
      }>
  );

/** A bounded, explicit-User evidence query; at most 256 entries are returned, oldest first. */
export type AuditQuery = Readonly<{ userId: string; limit: number }>;

/** Closed failure at the Audit runtime seam, without database errors, SQL, or rejected metadata. */
export class AuditUnavailable extends Data.TaggedError("AuditUnavailable") {}

/**
 * Supporting statement publication/review evidence retained without a credential in the D1
 * baseline. It cannot invent an acting credential or masquerade as another canonical call.
 */
export const AuditPublicationEvidence = AuditLogEntry.mapFields(Struct.omit(["caller"])).annotate({
  identifier: "AuditPublicationEvidence",
});
export type AuditPublicationEvidence = typeof AuditPublicationEvidence.Type;

/** Attributable evidence returned through the canonical metadata-only model. */
export { AuditLogEntry };
