import {
  type CategoryId,
  type CategoryKeyword,
  type KeywordRuleId,
} from "../../src/core/categories/contract";

import { Data, type Option } from "effect";

/** The Category owner cannot decide without authoritative, valid storage; no row or SQL escapes. */
export class CategoriesUnavailable extends Data.TaggedError("CategoriesUnavailable")<{}> {}

/** Every Category operation an accepted browser call may be attributable to. */
export type CategoryAuditOperation =
  | "categories.listCategories"
  | "categories.listKeywordRules"
  | "categories.createKeywordRule"
  | "categories.updateKeywordRule"
  | "categories.deleteKeywordRule";

/** The canonical mutation ids that retain one User's keyword-rule evidence. */
export type KeywordRuleOperation = Extract<
  CategoryAuditOperation,
  "categories.createKeywordRule" | "categories.updateKeywordRule" | "categories.deleteKeywordRule"
>;

/** Decoded capture facts; no keyword instructions or storage representations leave their owner. */
export type CaptureCategoryInput = Readonly<{
  caller: Option.Option<CategoryId>;
  counterparty: Option.Option<string>;
  direction: "inflow" | "outflow";
}>;

/**
 * One keyword-rule change's retained facts. A create or update names the rule's full payload; a
 * delete names only the rule it removes, so the correlation is a union instead of optional fields.
 */
export type KeywordRuleOutcome =
  | Readonly<{
      _tag: "KeywordRule";
      operation: "categories.createKeywordRule" | "categories.updateKeywordRule";
      ruleId: KeywordRuleId;
      keyword: CategoryKeyword;
      categoryId: CategoryId;
    }>
  | Readonly<{
      _tag: "KeywordRule";
      operation: "categories.deleteKeywordRule";
      ruleId: KeywordRuleId;
    }>;
