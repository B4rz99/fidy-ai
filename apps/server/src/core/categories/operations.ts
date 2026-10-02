import { Effect, Option } from "effect";
import {
  type Category,
  type CategoryFailure,
  type CategoryId,
  type CategoryKeyword,
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
import { categoryRows } from "~/core/categories/internal/taxonomy";

/** The directional last resort when capture has no explicit or matching keyword Category. */
export const fallbackCaptureCategory = (direction: "inflow" | "outflow"): CategoryId =>
  chooseFallback(direction);

/** The direct launch taxonomy, in presentation order, without seed or persistence attributes. */
export const listLaunchCategories = (): ReadonlyArray<Category> =>
  categoryRows.map(({ id, label }) => ({ id, label }));

/** Explicit choice wins; otherwise the most specific User instruction wins before the direction fallback. */
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

/** The complete requested rule transition, interpreted against one User's already-decoded rules. */
export type KeywordRuleChange =
  | Readonly<{
      operation: "categories.createKeywordRule" | "categories.updateKeywordRule";
      ruleId: KeywordRuleId;
      keyword: CategoryKeyword;
    }>
  | Readonly<{ operation: "categories.deleteKeywordRule"; ruleId: KeywordRuleId }>;

/** Reject missing ownership, then normalized duplicates, then capacity without mutating retained rules. */
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
