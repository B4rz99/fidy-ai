/** Contract examples, independent of MCP registration, installed-owner selection and access decisions. */
export const readDiscovery: ReadonlyArray<string> = [
  "budgets.getBudget",
  "budgets.getBudgetStatus",
  "budgets.listBudgets",
  "categories.listCategories",
  "categories.listKeywordRules",
  "dashboard.getDashboard",
  "dashboard.getDashboardView",
  "dashboard.listDashboardCatalog",
  "ingestion.getEmailForwarding",
  "ingestion.getStatementSubmission",
  "ingestion.listNeedsReviewItems",
  "insights.getRecurringDigestReport",
  "insights.getReminderSchedule",
  "insights.listPendingInsights",
  "memory.recall",
  "quota.getQuota",
  "recurring.listRecurringSeries",
  "subscription.getSubscriptionStatus",
  "subscription.getUpgradeUrl",
  "subscription.listSubscriptionOffers",
  "transactions.getTransaction",
  "transactions.listTransactions",
  "transactions.searchTransactions",
];
const ordinaryWriteDiscovery = [
  "budgets.createBudget",
  "categories.createKeywordRule",
  "ingestion.enableEmailForwarding",
  "memory.remember",
  "transactions.createTransaction",
  "transactions.linkTransactions",
  "transactions.unlinkTransactions",
];
const sensitiveWriteDiscovery = [
  "budgets.deleteBudget",
  "budgets.updateBudget",
  "categories.deleteKeywordRule",
  "categories.updateKeywordRule",
  "ingestion.abandonStatementSubmission",
  "ingestion.resolveNeedsReviewItem",
  "ingestion.skipNeedsReviewItem",
  "insights.dismissInsight",
  "insights.markInsightDelivered",
  "insights.markInsightRead",
  "insights.updateReminderSchedule",
  "memory.forget",
  "memory.revise",
  "transactions.updateTransaction",
];
const writeDiscovery = [...ordinaryWriteDiscovery, ...sensitiveWriteDiscovery];
const dashboardDiscovery = ["dashboard.initializeDashboard", "dashboard.applyDashboardEdit"];
// The wrapper is visible for every grant; execution authorizes each child separately.
const batchDiscovery = ["operations.executeAtomicBatch"];

export const sensitiveDiscovery: ReadonlySet<string> = new Set([
  ...sensitiveWriteDiscovery,
  "dashboard.applyDashboardEdit",
  ...batchDiscovery,
]);

// These declarations may occur in authorized continuations but have no installed MCP owner.
const additionalReadDeclarations = [
  "identity.getCurrentUser",
  "transactions.listSourceAttestations",
];
const additionalWriteDeclarations = [
  "identity.updateUserPreferences",
  "transactions.deleteTransaction",
];

export const discoveryCases = [
  {
    scopes: ["read"],
    tools: [...readDiscovery, ...batchDiscovery],
    additionalDeclarations: additionalReadDeclarations,
  },
  {
    scopes: ["write"],
    tools: [...writeDiscovery, ...batchDiscovery],
    additionalDeclarations: additionalWriteDeclarations,
  },
  {
    scopes: ["dashboard"],
    tools: [...dashboardDiscovery, ...batchDiscovery],
    additionalDeclarations: [],
  },
  {
    scopes: ["read", "write"],
    tools: [...readDiscovery, ...writeDiscovery, ...batchDiscovery],
    additionalDeclarations: [...additionalReadDeclarations, ...additionalWriteDeclarations],
  },
  {
    scopes: ["read", "dashboard"],
    tools: [...readDiscovery, ...dashboardDiscovery, ...batchDiscovery],
    additionalDeclarations: additionalReadDeclarations,
  },
  {
    scopes: ["write", "dashboard"],
    tools: [...writeDiscovery, ...dashboardDiscovery, ...batchDiscovery],
    additionalDeclarations: additionalWriteDeclarations,
  },
  {
    scopes: ["read", "write", "dashboard"],
    tools: [...readDiscovery, ...writeDiscovery, ...dashboardDiscovery, ...batchDiscovery],
    additionalDeclarations: [...additionalReadDeclarations, ...additionalWriteDeclarations],
  },
];

export const excludedAccountSecurityDiscovery = [
  "browserLogin.approvePairing",
  "emailAuthentication.completeEmailReplacement",
  "emailAuthentication.requestEmailReplacement",
  "pats.approvePATPairing",
  "pats.createManualPAT",
  "pats.inspectPATPairing",
  "pats.listPATs",
  "pats.revokeAllPATs",
  "pats.revokePAT",
  "recovery.rotateBackupRecoveryCode",
];
