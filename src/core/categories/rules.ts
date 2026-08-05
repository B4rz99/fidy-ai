import { Effect, Option } from "effect";
import type { ReadonlyOption } from "~/core/_shared/option";
import { type CategoryKeyword, type KeywordRuleId, normalizeCategoryKeyword } from "./model";

export { normalizeCategoryKeyword } from "./model";

/** Bounds the rules scanned during each Transaction capture for one User. */
export const maximumKeywordRulesPerUser = 100;

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
export const findKeywordCategory = <C extends string>(input: KeywordCategoryInput<C>) => {
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

/** Decides whether a normalized keyword is already claimed, excluding one rule during updates. */
export const hasKeywordRule = ({
  keyword,
  rules,
  excluding,
}: Readonly<{
  readonly keyword: typeof CategoryKeyword.Encoded;
  readonly rules: ReadonlyArray<CategoryRule<string>>;
  readonly excluding: ReadonlyOption<typeof KeywordRuleId.Encoded>;
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

/** Decides whether one more rule fits the bounded set of retained User rules. */
export const canCreateKeywordRule = (
  rules: ReadonlyArray<CategoryRule<string>>
): Effect.Effect<boolean> => Effect.succeed(rules.length < maximumKeywordRulesPerUser);

type KnownCategories<Category extends string> = Readonly<{
  readonly caller: ReadonlyOption<Category>;
  readonly keywordRule: ReadonlyOption<Category>;
}>;

/** Selects an explicit Category before a User rule; None leaves the model fallback available. */
export const findKnownCaptureCategory = <C extends string>(choices: KnownCategories<C>) => {
  const { caller, keywordRule } = choices;
  if (caller._tag === "Some") return Effect.succeed(Option.some(caller.value));
  if (keywordRule._tag === "Some") return Effect.succeed(Option.some(keywordRule.value));
  return Effect.succeed(Option.none<C>());
};
