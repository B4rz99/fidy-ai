import { validateKeywordRuleChange } from "../../../src/core/categories/operations";
import type { CategoryFailure, KeywordRule } from "../../../src/core/categories/contract";
import type { Effect, Option } from "effect";
import type { KeywordRuleOutcome } from "../../mutations/mutation-types";

/** Apply the same private rule policy before a write and while classifying its aborted commit. */
export const decideKeywordRuleConflict = ({
  rules,
  outcome,
}: Readonly<{ rules: ReadonlyArray<KeywordRule>; outcome: KeywordRuleOutcome }>): Effect.Effect<
  Option.Option<CategoryFailure>
> => validateKeywordRuleChange({ rules, change: outcome });
