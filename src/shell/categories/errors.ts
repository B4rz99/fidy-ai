import { type CategoryFailure } from "~/core/categories/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";

/** Maps actionable Category failures to the complete canonical API failure vocabulary. */
export const toApiFailure = (failure: CategoryFailure): NotFound | ValidationFailed => {
  switch (failure._tag) {
    case "CategoryNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: `No Category ${failure.categoryId} exists. List Categories and use one of their stable ids.`,
        },
        next: [],
      });
    case "KeywordRuleAlreadyExists":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "You already have an equivalent keyword rule. Edit the existing rule instead of creating an ambiguous duplicate.",
          fields: [
            {
              path: "keyword",
              message: `A case- and accent-insensitive rule for ${failure.keyword} already exists.`,
            },
          ],
        },
        next: [],
      });
    case "KeywordRuleLimitReached":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: `A User may retain at most ${failure.maximum} keyword rules. Edit or delete an existing rule before creating another.`,
          fields: [],
        },
        next: [],
      });
    case "KeywordRuleNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: `No keyword rule ${failure.keywordRuleId} belongs to you. List your keyword rules to find an id you can change.`,
        },
        next: [],
      });
  }
};
