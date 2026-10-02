/** Browser-safe Category declarations and pure owner behavior for native runtime composition. */
export * from "~/core/categories/contract";
export { CategoryId } from "~/core/categories/reference";
export {
  fallbackCaptureCategory,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
} from "~/core/categories/operations";
export * from "./contract";
export {
  categoryUnavailable,
  listCategoriesResponse,
  toApiFailure,
  prepareCategoryRead,
  decodeCategoryRead,
} from "./operations";
export { decideOperationAccess, getOperationPolicy } from "~/shell/_shared/operation-policy";
export type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
export {
  NotFound,
  ScopeMissing,
  UserActionRequired,
  ValidationFailed,
} from "~/shell/public-http/contract";
