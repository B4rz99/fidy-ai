import { expect, it } from "vitest";
import { nativeMcpCatalog } from "./operations";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import {
  OperationAccessCaller,
  OperationAccessDecision,
} from "../../src/shell/canonical-policy/contract";

const published = [
  "budgets.createBudget",
  "budgets.deleteBudget",
  "budgets.getBudget",
  "budgets.getBudgetStatus",
  "budgets.listBudgets",
  "budgets.updateBudget",
  "categories.createKeywordRule",
  "categories.deleteKeywordRule",
  "categories.listCategories",
  "categories.listKeywordRules",
  "categories.updateKeywordRule",
  "connections.connectInstitution",
  "connections.getConnection",
  "connections.listAccounts",
  "connections.listConnections",
  "connections.listInstitutions",
  "dashboard.applyDashboardEdit",
  "dashboard.getDashboard",
  "dashboard.getDashboardView",
  "dashboard.initializeDashboard",
  "dashboard.listDashboardCatalog",
  "ingestion.abandonStatementSubmission",
  "ingestion.applyReviewEdit",
  "ingestion.enableEmailForwarding",
  "ingestion.getEmailForwarding",
  "ingestion.getReviewItem",
  "ingestion.getReviewWorkspace",
  "ingestion.getStatementSubmission",
  "ingestion.listNeedsReviewItems",
  "ingestion.resolveNeedsReviewItem",
  "ingestion.skipNeedsReviewItem",
  "insights.dismissInsight",
  "insights.getRecurringDigestReport",
  "insights.getReminderSchedule",
  "insights.listPendingInsights",
  "insights.markInsightDelivered",
  "insights.markInsightRead",
  "insights.updateReminderSchedule",
  "memory.forget",
  "memory.recall",
  "memory.remember",
  "memory.revise",
  "operations.executeAtomicBatch",
  "quota.getQuota",
  "recurring.listRecurringSeries",
  "recurringPlans.applyRecurringEdit",
  "recurringPlans.getRecurringWorkspace",
  "subscription.cancelSubscription",
  "subscription.getSubscriptionStatus",
  "subscription.getUpgradeUrl",
  "subscription.listSubscriptionOffers",
  "transactions.createTransaction",
  "transactions.deleteTransaction",
  "transactions.getTransaction",
  "transactions.linkTransactions",
  "transactions.listTransactions",
  "transactions.searchTransactions",
  "transactions.unlinkTransactions",
  "transactions.updateTransaction",
  "transactions.updateTransactions",
];

it("preserves the exact public OAuth MCP tool catalog after shared reads are retired", () => {
  const actual = nativeMcpCatalog()
    .filter((operation) =>
      OperationAccessDecision.$is("Allowed")(
        decideOperationAccess(
          operation.policy.access,
          OperationAccessCaller.OAuthAgent({ capabilities: ["read", "write", "dashboard"] })
        )
      )
    )
    .map(({ id }) => id)
    .toSorted();

  expect(actual).toEqual(published);
});
