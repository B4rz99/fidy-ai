import { Effect, Schema } from "effect";
import { encodeJson, readJson, requireCheck } from "./production-fixture";
import type { NativeHost } from "./production-native";

// Worked permission expectation owned by this verifier, independent of server registration.
const expectedReadWriteTools = [
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
  "budgets.createBudget",
  "categories.createKeywordRule",
  "ingestion.enableEmailForwarding",
  "memory.remember",
  "transactions.createTransaction",
  "transactions.linkTransactions",
  "transactions.unlinkTransactions",
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
  "subscription.cancelSubscription",
  "transactions.updateTransaction",
  "operations.executeAtomicBatch",
];
const excludedOperations = [
  "dashboard.initializeDashboard",
  "dashboard.applyDashboardEdit",
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
const NamedTool = Schema.Struct({
  name: Schema.String,
  input_schema: Schema.optionalKey(Schema.Unknown),
  parameters: Schema.optionalKey(Schema.Unknown),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        parameters: Schema.optionalKey(Schema.Unknown),
      })
    )
  ),
});
// Codex's built-in web search has a type and no name. It is not an MCP namespace.
const CodexCatalog = Schema.Array(
  Schema.Union([NamedTool, Schema.Struct({ type: Schema.Literal("web_search") })])
);
const ClaudeCatalog = Schema.Array(NamedTool);
export const validateCatalog = Effect.fn(function* (root: string, host: NativeHost) {
  const tools =
    host === "claude"
      ? yield* readJson(ClaudeCatalog, `${root}/${host}-catalog-private.json`)
      : ((yield* readJson(CodexCatalog, `${root}/${host}-catalog-private.json`))
          .filter(Schema.is(NamedTool))
          .find((tool) => tool.name === "mcp__fidy")?.tools ?? []);
  const names = tools.map((tool) => tool.name.replace(/^mcp__fidy__/u, "")).sort();
  const expected = expectedReadWriteTools.map((name) => name.replaceAll(".", "_")).sort();
  yield* requireCheck(
    encodeJson(names) === encodeJson(expected),
    "Native restricted catalog did not match the permission contract"
  );
  const schemas = encodeJson(
    tools.map((tool) => ("input_schema" in tool ? tool.input_schema : tool.parameters))
  );
  yield* requireCheck(
    excludedOperations.every((name) => !schemas.includes(`"${name}"`)),
    "Unauthorized operation identifier leaked into native input schemas"
  );
});
