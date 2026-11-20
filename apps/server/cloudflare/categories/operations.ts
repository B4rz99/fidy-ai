import {
  newKeywordRuleId as allocateRuleId,
  localKeywordRules as listRules,
  prepareLocalKeywordRule as prepareRule,
} from "./internal/sqlite-keyword";
import {
  categorizeLocalCapture as nativeCategory,
  resolveLocalCategory as resolveCategory,
  retainLocalCategory as retainCategory,
} from "./internal/native-categorization";
import { captureCategories, prepareCaptureCategories as prepareCaptures } from "./internal/capture";
import type { QueryAuthority } from "../canonical-work/operations";
import {
  prepareBoundCategoryRead as prepareBrowserRead,
  executeProtectedCategories as readProtectedCategories,
} from "./internal/canonical-category";
import type { CanonicalBrowserRead } from "../canonical-admission/contract";
import { keywordRuleGuardFailure as classifyRuleGuardFailure } from "./internal/keyword-rule-outcome";
import type { Effect, Option } from "effect";
import {
  type Category,
  type CategoryId,
  type CategoryNotFound,
} from "../../src/core/categories/contract";
import type { CategoriesUnavailable } from "./contract";

import {
  categoryList,
  categoryReferenceStatement,
  prepareCategorySnapshot as preparePeerSnapshot,
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

export const prepareCategorySnapshot = (
  input: Readonly<{ db: D1Database; authority: QueryAuthority }>
): Readonly<{
  statement: D1PreparedStatement;
  decode: (rows: unknown) => Option.Option<ReadonlyArray<Category>>;
}> => preparePeerSnapshot(input);

export const prepareBoundCategoryRead: CanonicalBrowserRead = (input) => prepareBrowserRead(input);

export const requireCategory = (
  input: Readonly<{ db: D1Database; categoryId: CategoryId }>
): Effect.Effect<Category, CategoryNotFound | CategoriesUnavailable> => requiredCategory(input);

export const listCategories = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<ReadonlyArray<Category>, CategoriesUnavailable> => categoryList(input);

export const categorizeCaptures: typeof captureCategories = (input) => captureCategories(input);

export const executeProtectedCategories: typeof readProtectedCategories = (input) =>
  readProtectedCategories(input);

export const listOwnKeywordRules: typeof readOwnKeywordRules = (input) =>
  readOwnKeywordRules(input);
export const keywordRuleInput: typeof decodeRuleInput = (input) => decodeRuleInput(input);

export const keywordRuleIdFromPath: typeof decodeRuleId = (input) => decodeRuleId(input);

export const keywordRuleInvalidInput = (): Response => invalidRuleInput();

export const keywordRuleUnknownId = (): Response => unknownRuleId();

export const prepareCreateKeywordRule: typeof createRule = (input) => createRule(input);

export const prepareUpdateKeywordRule: typeof updateRule = (input) => updateRule(input);

export const prepareDeleteKeywordRule: typeof deleteRule = (input) => deleteRule(input);
export const keywordRuleGuardFailure: typeof classifyRuleGuardFailure = (input) =>
  classifyRuleGuardFailure(input);

export const prepareCategoryReference: typeof categoryReferenceStatement = (input) =>
  categoryReferenceStatement(input);

export const verifyCategoryStorage = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<void, CategoriesUnavailable> => verifyStorage(input);

export const prepareCaptureCategories: typeof prepareCaptures = (input) => prepareCaptures(input);

export const categorizeLocalCapture: typeof nativeCategory = (input) => nativeCategory(input);
export const localKeywordRules: typeof listRules = (user) => listRules(user);
export const newKeywordRuleId: typeof allocateRuleId = () => allocateRuleId();
export const prepareLocalKeywordRule: typeof prepareRule = (command, user, current) =>
  prepareRule(command, user, current);

export const resolveLocalCategory: typeof resolveCategory = (input) => resolveCategory(input);
export const retainLocalCategory: typeof retainCategory = (reference) => retainCategory(reference);
