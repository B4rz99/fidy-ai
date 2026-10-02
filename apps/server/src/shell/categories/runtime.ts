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
export { decideOperationAccess } from "~/shell/canonical-policy/operations";
export { getOperationPolicy } from "~/shell/canonical-policy/contract";
export type { SuggestedOperationCaller } from "~/shell/canonical-operations/operations";
export {
  NotFound,
  ScopeMissing,
  UserActionRequired,
  ValidationFailed,
} from "~/shell/public-http/contract";
