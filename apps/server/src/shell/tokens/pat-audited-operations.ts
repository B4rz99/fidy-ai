/**
 * The closed set of canonical operations whose successful PAT work is accounted for in `pat_audit`.
 * It lives beside both writers rather than inside either one: the canonical Audit writer and the
 * PAT-activity writer each need the vocabulary, and importing it from the other would make the two
 * modules one.
 */
export type AuditedPATOperation =
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
  | "ingestion.enableEmailForwarding"
  | "ingestion.getEmailForwarding"
  | "ingestion.getStatementSubmission"
  | "ingestion.listNeedsReviewItems"
  | "ingestion.submitForExtraction"
  | "insights.listPendingInsights"
  | "insights.markInsightDelivered"
  | "insights.markInsightRead"
  | "insights.dismissInsight"
  | "memory.forget"
  | "memory.recall"
  | "memory.remember"
  | "memory.revise"
  | "subscription.getSubscriptionStatus"
  | "subscription.listSubscriptionOffers"
  | "transactions.createTransaction"
  | "transactions.getTransaction"
  | "transactions.linkTransactions"
  | "transactions.listTransactions"
  | "transactions.searchTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.updateTransaction";
