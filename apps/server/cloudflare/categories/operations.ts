import { captureCategories } from "./internal/capture";
import {
  prepareBoundCategoryRead as prepareBrowserRead,
  executeProtectedCategories as readProtectedCategories,
} from "./internal/canonical-category";
import type { CanonicalBrowserRead } from "../canonical-admission/contract";
import { keywordRuleGuardFailure as classifyRuleGuardFailure } from "./internal/keyword-rule-outcome";
import type { Effect } from "effect";
import {
  type Category,
  type CategoryId,
  type CategoryNotFound,
} from "../../src/core/categories/contract";
import type { CategoriesUnavailable } from "./contract";

import {
  categoryList,
  categoryReferenceStatement,
  requiredCategory,
  verifyStorage,
} from "./internal/projection";
import {
  prepareCreateKeywordRule as createRule,
  keywordRuleIdFromPath as decodeRuleId,
  keywordRuleInput as decodeRuleInput,
  prepareDeleteKeywordRule as deleteRule,
  keywordRuleInvalidInput as invalidRuleInput,
  listOwnKeywordRules as readOwnKeywordRules,
  keywordRuleUnknownId as unknownRuleId,
  prepareUpdateKeywordRule as updateRule,
} from "./internal/canonical-keyword-rules";

/** Compose the bounded Category listing and its Audit in a protected browser snapshot. */
export const prepareBoundCategoryRead: CanonicalBrowserRead = (input) => prepareBrowserRead(input);

export const requireCategory = (
  input: Readonly<{ db: D1Database; categoryId: CategoryId }>
): Effect.Effect<Category, CategoryNotFound | CategoriesUnavailable> => requiredCategory(input);

/** Return the complete bounded taxonomy in current presentation order, or fail rather than truncate. */
export const listCategories = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<ReadonlyArray<Category>, CategoriesUnavailable> => categoryList(input);

/**
 * Categorize up to 100 captures for one established User, preserving input order and hiding rules.
 * The caller owns authentication and its existing User-coordinated unit; this read grants no write authority.
 */
export const categorizeCaptures: typeof captureCategories = (input) => captureCategories(input);

/** Canonical Category read with live credential, Consent and audit in one native D1 unit. */
export const executeProtectedCategories: typeof readProtectedCategories = (input) =>
  readProtectedCategories(input);
/** List the caller's bounded keyword instructions under their live credential. */
export const listOwnKeywordRules: typeof readOwnKeywordRules = (input) =>
  readOwnKeywordRules(input);
export const keywordRuleInput: typeof decodeRuleInput = (input) => decodeRuleInput(input);
/** Decode a retained rule's stable public path identity. */
export const keywordRuleIdFromPath: typeof decodeRuleId = (input) => decodeRuleId(input);
/** Report malformed public rule input without retaining or auditing it. */
export const keywordRuleInvalidInput = (): Response => invalidRuleInput();
/** Report an absent or foreign rule identity without revealing ownership. */
export const keywordRuleUnknownId = (): Response => unknownRuleId();
/** Prepare one rule creation inside the caller's atomic, User-coordinated mutation unit. */
export const prepareCreateKeywordRule: typeof createRule = (input) => createRule(input);
/** Prepare one owned rule replacement, affecting only future capture. */
export const prepareUpdateKeywordRule: typeof updateRule = (input) => updateRule(input);
/** Prepare one owned rule removal, affecting only future capture. */
export const prepareDeleteKeywordRule: typeof deleteRule = (input) => deleteRule(input);
export const keywordRuleGuardFailure: typeof classifyRuleGuardFailure = (input) =>
  classifyRuleGuardFailure(input);

/**
 * Compose the exact Category's continued existence into a caller-owned action. category_reference(id)
 * is re-evaluated when the action commits; lookup results alone are not a commit-time guarantee.
 */
export const prepareCategoryReference: typeof categoryReferenceStatement = (input) =>
  categoryReferenceStatement(input);

/** Verify Category storage is installed for release smoke without loading any retained content. */
export const verifyCategoryStorage = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<void, CategoriesUnavailable> => verifyStorage(input);
