import { Effect, Option } from "effect";
import {
  type CategoryFailure,
  type KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
  canCreateKeywordRule,
  hasKeywordRule,
  maximumKeywordRulesPerUser,
} from "@fidy/server/categories";
import type { KeywordRuleOutcome } from "../mutations/mutation-types";

/**
 * Decide a rule change against one User's already-decoded retained rules. Preparation and
 * post-abort classification use the same conflict order; only their reads and failure handling
 * differ.
 */
export const decideKeywordRuleConflict = ({
  rules,
  outcome,
}: Readonly<{
  rules: ReadonlyArray<KeywordRule>;
  outcome: KeywordRuleOutcome;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    if (
      outcome.operation !== "categories.createKeywordRule" &&
      !rules.some((rule) => rule.id === outcome.ruleId)
    ) {
      return Option.some(new KeywordRuleNotFound({ keywordRuleId: outcome.ruleId }));
    }
    if (outcome.operation !== "categories.deleteKeywordRule") {
      const duplicate = yield* hasKeywordRule({
        keyword: outcome.keyword,
        rules,
        excluding:
          outcome.operation === "categories.updateKeywordRule"
            ? Option.some(outcome.ruleId)
            : Option.none(),
      });
      if (duplicate) return Option.some(new KeywordRuleAlreadyExists({ keyword: outcome.keyword }));
    }
    if (
      outcome.operation === "categories.createKeywordRule" &&
      !(yield* canCreateKeywordRule(rules))
    ) {
      return Option.some(new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }));
    }
    return Option.none<CategoryFailure>();
  });
