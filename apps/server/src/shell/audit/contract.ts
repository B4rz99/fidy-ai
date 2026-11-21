import { Data, Struct } from "effect";
import type { OAuthAuthority } from "~/shell/oauth-agents/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { AuditLogEntry } from "~/core/audit/contract";

export type AuditCredentialOperation =
  | "consent.withdraw"
  | "consent.renew"
  | "privacy.transactions"
  | "connections.listInstitutions"
  | "connections.listConnections"
  | "connections.getConnection"
  | "connections.listAccounts"
  | "connections.connectInstitution"
  | "connections.reviewContinuation"
  | "connections.beginContinuation"
  | "connections.claimAuthorization"
  | "connections.completeAuthorization"
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
  | "dashboard.initializeDashboard"
  | "dashboard.getDashboard"
  | "dashboard.getDashboardView"
  | "dashboard.listDashboardCatalog"
  | "dashboard.applyDashboardEdit"
  | "ingestion.enableEmailForwarding"
  | "ingestion.getEmailForwarding"
  | "ingestion.getStatementSubmission"
  | "ingestion.listNeedsReviewItems"
  | "ingestion.getReviewWorkspace"
  | "ingestion.getReviewMaterial"
  | "ingestion.getReviewPageContext"
  | "ingestion.getReviewItem"
  | "ingestion.applyReviewEdit"
  | "ingestion.submitForExtraction"
  | "ingestion.resolveNeedsReviewItem"
  | "ingestion.skipNeedsReviewItem"
  | "ingestion.abandonStatementSubmission"
  | "insights.getRecurringDigestReport"
  | "insights.getReminderSchedule"
  | "insights.updateReminderSchedule"
  | "insights.listPendingInsights"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight"
  | "recurring.listRecurringSeries"
  | "recurringPlans.getRecurringWorkspace"
  | "recurringPlans.applyRecurringEdit"
  | "memory.forget"
  | "memory.recall"
  | "memory.remember"
  | "memory.revise"
  | "operations.executeAtomicBatch"
  | "quota.getQuota"
  | "subscription.cancelSubscription"
  | "subscription.getUpgradeUrl"
  | "subscription.getSubscriptionStatus"
  | "subscription.listSubscriptionOffers"
  | "transactions.createTransaction"
  | "transactions.getTransaction"
  | "transactions.linkTransactions"
  | "transactions.listTransactions"
  | "transactions.searchTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.deleteTransaction"
  | "transactions.updateTransactions"
  | "transactions.updateTransaction";

export type AuditPublicationOperation =
  | "ingestion.submitForExtraction"
  | "ingestion.listNeedsReviewItems";

export const utcDayMilliseconds = 86400000;

export const auditRetentionDays = 365;

export type AuditAuthority =
  | Readonly<{
      table: "web_sessions" | "pats" | "hosted_turns";
      predicate: string;
      bindings: ReadonlyArray<string | number | Uint8Array>;
    }>
  | OAuthAuthority;

type AcceptedSessionOperation =
  | "ingestion.getReviewWorkspace"
  | "ingestion.getReviewMaterial"
  | "ingestion.getReviewPageContext"
  | "ingestion.getReviewItem"
  | "ingestion.applyReviewEdit"
  | "recurringPlans.getRecurringWorkspace"
  | "recurringPlans.applyRecurringEdit"
  | Extract<
      AuditCredentialOperation,
      `${"consent" | "privacy" | "connections" | "budgets" | "dashboard" | "insights" | "subscription" | "recurring" | "quota"}.${string}`
    >;

type CategoryOperation = Extract<AuditCredentialOperation, `categories.${string}`>;

type LegacySessionOperation = Exclude<
  AuditCredentialOperation,
  AcceptedSessionOperation | CategoryOperation | "ingestion.listNeedsReviewItems"
>;

type AcceptedOutcome = "accepted" | "rejected";

type LegacyOutcome = "success" | "not_found" | "validation_failed" | "resource_limit";

type SessionDecision =
  | Readonly<{ operation: LegacySessionOperation; outcome: LegacyOutcome }>
  | Readonly<{ operation: CategoryOperation; outcome: "success" | "validation_failed" }>
  | Readonly<{ operation: "ingestion.listNeedsReviewItems"; outcome: "success" }>;

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
        authority: AuditAuthority & { table: "pats" | "oauth_credentials" | "hosted_turns" };
        operation: AuditCredentialOperation;
        outcome: AcceptedOutcome;
      }>
    | (Readonly<{ authority: AuditAuthority & { table: "web_sessions" | "hosted_turns" } }> &
        SessionDecision)
  );

export type AuditQueryCall = Readonly<{
  authority: AuditAuthority;
  id: string;
  operation:
    | "connections.reviewContinuation"
    | "connections.getConnection"
    | "connections.listAccounts"
    | "transactions.getTransaction"
    | "transactions.listTransactions"
    | "transactions.searchTransactions"
    | "ingestion.getStatementSubmission"
    | "ingestion.getReviewItem";
  current: number;
  missingWhen: OwnedStatement;
}>;

export type AuditActor = Data.TaggedEnum<{
  WebSession: { readonly id: string };
  PAT: { readonly id: string };
  Publication: {};
}>;

export const AuditActor = Data.taggedEnum<AuditActor>();

export type OwnerAuditCall = Readonly<{
  id: string;
  userId: string;
  current: number;
  when: OwnedStatement;
  afterOwnerWrite: boolean;
}> &
  (
    | Readonly<{
        caller: Data.TaggedEnum.Value<AuditActor, "WebSession" | "PAT">;
        operation: AcceptedSessionOperation;
        outcome: AcceptedOutcome;
      }>
    | Readonly<{
        caller: Data.TaggedEnum.Value<AuditActor, "PAT">;
        operation: AuditCredentialOperation;
        outcome: AcceptedOutcome;
      }>
    | (Readonly<{ caller: Data.TaggedEnum.Value<AuditActor, "WebSession"> }> & SessionDecision)
    | Readonly<{
        caller: Data.TaggedEnum.Value<AuditActor, "Publication">;
        operation: AuditPublicationOperation;
        outcome: "success";
      }>
  );

export type AuditQuery = Readonly<{ userId: string; limit: number }>;

export class AuditUnavailable extends Data.TaggedError("AuditUnavailable")<{
  readonly cause: unknown;
}> {}

export const AuditPublicationEvidence = AuditLogEntry.mapFields(Struct.omit(["caller"])).annotate({
  identifier: "AuditPublicationEvidence",
});

export type AuditPublicationEvidence = typeof AuditPublicationEvidence.Type;

export { AuditLogEntry };

export type PATActivityAuthority = Readonly<{
  table: "web_sessions" | "hosted_turns";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
