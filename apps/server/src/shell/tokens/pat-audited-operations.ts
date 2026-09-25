/**
 * The closed set of canonical operations whose successful PAT work is accounted for in `pat_audit`.
 * It lives beside both writers rather than inside either one: the canonical Audit writer and the
 * PAT-activity writer each need the vocabulary, and importing it from the other would make the two
 * modules one.
 */
export type AuditedPATOperation =
  | "categories.createKeywordRule"
  | "categories.deleteKeywordRule"
  | "categories.listCategories"
  | "categories.listKeywordRules"
  | "categories.updateKeywordRule"
  | "ingestion.getStatementSubmission"
  | "ingestion.submitForExtraction"
  | "memory.forget"
  | "memory.recall"
  | "memory.remember"
  | "memory.revise"
  | "transactions.createTransaction"
  | "transactions.getTransaction"
  | "transactions.linkTransactions"
  | "transactions.listTransactions"
  | "transactions.searchTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.updateTransaction";
