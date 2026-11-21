import releaseData from "~/core/categories/internal/taxonomy-release.json";
import { Effect, Option, Schema } from "effect";
import {
  type Category,
  type CategoryFailure,
  type CategoryId,
  type CategoryKeyword,
  CategoryTaxonomyRelease,
  type KeywordRule,
  KeywordRuleAlreadyExists,
  type KeywordRuleId,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
  maximumKeywordRulesPerUser,
} from "./contract";
import {
  canCreateKeywordRule,
  fallbackCaptureCategory as chooseFallback,
  findKeywordCategory,
  findKnownCaptureCategory,
  hasKeywordRule,
} from "~/core/categories/internal/rules";
import {
  canOverlap,
  interpretReference,
  writingTaxonomy,
} from "~/core/categories/internal/taxonomy";

export const fallbackCaptureCategory = (direction: "inflow" | "outflow"): CategoryId =>
  chooseFallback(direction);

export const listLaunchCategories = (): ReadonlyArray<Category> =>
  writingTaxonomy(currentCategoryRelease).categories;

export const categorizeCapture = ({
  caller,
  counterparty,
  direction,
  rules,
}: Readonly<{
  caller: Option.Option<CategoryId>;
  counterparty: Option.Option<string>;
  direction: "inflow" | "outflow";
  rules: ReadonlyArray<Pick<KeywordRule, "id" | "keyword" | "categoryId">>;
}>): Effect.Effect<CategoryId> =>
  Effect.gen(function* () {
    const keywordRule = Option.isNone(counterparty)
      ? Option.none<CategoryId>()
      : yield* findKeywordCategory({ counterparty: counterparty.value, rules });

    const known = yield* findKnownCaptureCategory({ caller, keywordRule });

    return Option.getOrElse(known, () => fallbackCaptureCategory(direction));
  });

export type KeywordRuleChange =
  | Readonly<{
      operation: "categories.createKeywordRule" | "categories.updateKeywordRule";
      ruleId: KeywordRuleId;
      keyword: CategoryKeyword;
    }>
  | Readonly<{ operation: "categories.deleteKeywordRule"; ruleId: KeywordRuleId }>;

export const validateKeywordRuleChange = ({
  rules,
  change,
}: Readonly<{ rules: ReadonlyArray<KeywordRule>; change: KeywordRuleChange }>): Effect.Effect<
  Option.Option<CategoryFailure>
> =>
  Effect.gen(function* () {
    if (
      change.operation !== "categories.createKeywordRule" &&
      !rules.some((rule) => rule.id === change.ruleId)
    ) {
      return Option.some(new KeywordRuleNotFound({ keywordRuleId: change.ruleId }));
    }

    if (
      change.operation !== "categories.deleteKeywordRule" &&
      (yield* hasKeywordRule({
        keyword: change.keyword,
        rules,
        excluding:
          change.operation === "categories.updateKeywordRule"
            ? Option.some(change.ruleId)
            : Option.none(),
      }))
    ) {
      return Option.some(new KeywordRuleAlreadyExists({ keyword: change.keyword }));
    }

    if (
      change.operation === "categories.createKeywordRule" &&
      !(yield* canCreateKeywordRule(rules))
    ) {
      return Option.some(new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }));
    }

    return Option.none<CategoryFailure>();
  });

const decodedRelease = Schema.decodeSync(CategoryTaxonomyRelease)(releaseData);

for (const revision of decodedRelease.revisions) {
  for (const category of revision.categories) Object.freeze(category);
  Object.freeze(revision.categories);
  Object.freeze(revision);
}

Object.freeze(decodedRelease.revisions);

export const currentCategoryRelease = Object.freeze(decodedRelease);

export const activeCategoryTaxonomy: typeof writingTaxonomy = (release) => writingTaxonomy(release);

export const compatibleCategoryReleases: typeof canOverlap = (input) => canOverlap(input);

export const interpretCategory: typeof interpretReference = (input) => interpretReference(input);
