import { Data } from "effect";
import { type CategoryId } from "~/core/_shared/category";
import { type CategoryKeyword, type KeywordRuleId } from "./model";

/** The requested stable Category identity is not present in the configured taxonomy. */
export class CategoryNotFound extends Data.TaggedError("CategoryNotFound")<{
  readonly categoryId: CategoryId;
}> {}

/** The User already has a rule with the same normalized keyword. */
export class KeywordRuleAlreadyExists extends Data.TaggedError("KeywordRuleAlreadyExists")<{
  readonly keyword: CategoryKeyword;
}> {}

/** The requested rule does not belong to the current User or no longer exists. */
export class KeywordRuleNotFound extends Data.TaggedError("KeywordRuleNotFound")<{
  readonly keywordRuleId: KeywordRuleId;
}> {}

/** The User already retains the bounded maximum of capture-time keyword rules. */
export class KeywordRuleLimitReached extends Data.TaggedError("KeywordRuleLimitReached")<{
  readonly maximum: number;
}> {}

/** Actionable failures produced while validating or changing Category rules. */
export type CategoryFailure =
  | CategoryNotFound
  | KeywordRuleAlreadyExists
  | KeywordRuleNotFound
  | KeywordRuleLimitReached;
