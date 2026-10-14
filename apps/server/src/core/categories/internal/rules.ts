import { Effect, Option } from "effect";
import {
  type CategoryId,
  type CategoryKeyword,
  type KeywordRuleId,
  categoryIds,
  maximumKeywordRulesPerUser,
} from "~/core/categories/contract";

import { normalizeSearchText as normalizeCategoryKeyword } from "~/core/search/operations";

export const fallbackCaptureCategory = (direction: "inflow" | "outflow"): CategoryId =>
  direction === "inflow" ? categoryIds.ingresos : categoryIds.otros;

type CategoryRule<Category extends string> = Readonly<{
  id: string;
  keyword: string;
  categoryId: Category;
}>;

type KeywordCategoryInput<Category extends string> = Readonly<{
  readonly counterparty: string;
  readonly rules: ReadonlyArray<CategoryRule<Category>>;
}>;

/** Selects the longest matching rule; lexical rule identity resolves equal-specificity ties. */
export const findKeywordCategory = <Category extends string>(
  input: KeywordCategoryInput<Category>
): Effect.Effect<Option.Option<Category>> => {
  const { counterparty, rules } = input;
  const normalizedCounterparty = normalizeCategoryKeyword(counterparty);
  const matching = rules
    .filter((rule) => normalizedCounterparty.includes(normalizeCategoryKeyword(rule.keyword)))
    .toSorted(
      (left, right) =>
        normalizeCategoryKeyword(right.keyword).length -
          normalizeCategoryKeyword(left.keyword).length || left.id.localeCompare(right.id)
    );

  const first = matching[0];
  return Effect.succeed(first === undefined ? Option.none() : Option.some(first.categoryId));
};

export const hasKeywordRule = ({
  keyword,
  rules,
  excluding,
}: Readonly<{
  readonly keyword: typeof CategoryKeyword.Encoded;
  readonly rules: ReadonlyArray<CategoryRule<string>>;
  readonly excluding: Option.Option<typeof KeywordRuleId.Encoded>;
}>): Effect.Effect<boolean> => {
  const normalized = normalizeCategoryKeyword(keyword);
  return Effect.succeed(
    rules.some(
      (rule) =>
        !(excluding._tag === "Some" && excluding.value === rule.id) &&
        normalizeCategoryKeyword(rule.keyword) === normalized
    )
  );
};

export const canCreateKeywordRule = (
  rules: ReadonlyArray<CategoryRule<string>>
): Effect.Effect<boolean> => Effect.succeed(rules.length < maximumKeywordRulesPerUser);

type KnownCategories<Category extends string> = Readonly<{
  readonly caller: Option.Option<Category>;
  readonly keywordRule: Option.Option<Category>;
}>;

/** Selects an explicit Category before a User rule; None leaves the model fallback available. */
export const findKnownCaptureCategory = <Category extends string>(
  choices: KnownCategories<Category>
): Effect.Effect<Option.Option<Category>> =>
  Effect.succeed(Option.orElse(choices.caller, () => choices.keywordRule));
