import { CategoryId, CategoryKeyword, KeywordRuleId } from "../../src/core/categories/contract";

import { Data, type Option, Schema } from "effect";

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

export const KeywordRuleChange = Schema.TaggedStruct("KeywordRule", {
  operation: Schema.Literals(["categories.createKeywordRule", "categories.updateKeywordRule"]),
  ruleId: KeywordRuleId,
  keyword: CategoryKeyword,
  categoryId: CategoryId,
});

export const KeywordRuleRemoval = Schema.TaggedStruct("KeywordRule", {
  operation: Schema.Literal("categories.deleteKeywordRule"),
  ruleId: KeywordRuleId,
});

export type KeywordRuleOutcome = typeof KeywordRuleChange.Type | typeof KeywordRuleRemoval.Type;
