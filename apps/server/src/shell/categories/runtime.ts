/** Runtime Category schema and canonical query/mutation adapters published to the private Core Worker. */
export { Category } from "~/core/categories/model";
export { categoryIds, categoryRows } from "~/core/categories/taxonomy";
export {
  CategoryKeyword,
  CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  UpdateKeywordRuleInput,
} from "~/core/categories/model";
export { CategoryId } from "~/core/categories/reference";
export type { CategoryFailure } from "~/core/categories/errors";
export {
  CategoryNotFound,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
} from "~/core/categories/errors";
export {
  canCreateKeywordRule,
  findKeywordCategory,
  findKnownCaptureCategory,
  hasKeywordRule,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
} from "~/core/categories/rules";
export {
  CategoryQueryFailure,
  categoryUnavailable,
  listCategoriesResponse,
} from "./list-categories";
export {
  CategoriesGroup,
  KeywordRuleResponse,
  ListCategoriesResponse,
  ListKeywordRulesResponse,
  RemovedKeywordRuleResponse,
} from "./operations";
export { toApiFailure } from "./errors";
export { categoryRowsQuery, categoryResponseFromRows } from "./query";
export {
  categoryMutationCompletion,
  insertKeywordRule,
  keywordRuleFromRows,
  keywordRuleQuery,
  keywordRulesFromRows,
  keywordRulesQuery,
  protectedKeywordRulesQuery,
  recordBrowserKeywordRuleRead,
  recordBrowserKeywordRuleWork,
  removeKeywordRule,
  replaceKeywordRule,
} from "./keyword-rules";
export type {
  CategoryAuditOperation,
  KeywordRuleOperation,
  KeywordRuleRemoval,
  KeywordRuleWrite,
} from "./keyword-rules";
export { recordBrowserCategoryWork } from "./canonical-work";
export { decideOperationAccess, getOperationPolicy } from "~/shell/_shared/operation-policy";
export type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
export {
  NotFound,
  ScopeMissing,
  UserActionRequired,
  ValidationFailed,
} from "~/shell/public-http/contract";
export { listCategoriesPath } from "./path";
