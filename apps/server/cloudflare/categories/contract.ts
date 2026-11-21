import {
  type CategoryId,
  type CategoryKeyword,
  type KeywordRuleId,
} from "../../src/core/categories/contract";

import { Data, type Option } from "effect";

export class CategoriesUnavailable extends Data.TaggedError("CategoriesUnavailable")<{}> {}

export type CategoryAuditOperation =
  | "categories.listCategories"
  | "categories.listKeywordRules"
  | "categories.createKeywordRule"
  | "categories.updateKeywordRule"
  | "categories.deleteKeywordRule";

export type CaptureCategoryInput = Readonly<{
  caller: Option.Option<CategoryId>;
  counterparty: Option.Option<string>;
  direction: "inflow" | "outflow";
}>;

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
