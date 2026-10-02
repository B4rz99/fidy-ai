import type { CategoryId } from "../../src/core/categories/reference";
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
