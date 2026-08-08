import { type CategoryFailure } from "~/core/categories/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import type { SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

const categoryRecovery = (caller: SuggestedOperationCaller): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "categories.listCategories",
        hint: "List Categories to choose one of their stable ids.",
      }),
    ],
    caller,
  });

const keywordRuleRecovery = (caller: SuggestedOperationCaller): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "categories.listKeywordRules",
        hint: "List keyword rules to choose one you can change.",
      }),
    ],
    caller,
  });

/** Maps actionable Category failures to the complete canonical API failure vocabulary. */
export const toApiFailure = ({
  failure,
  caller,
}: {
  readonly failure: CategoryFailure;
  readonly caller: SuggestedOperationCaller;
}): NotFound | ValidationFailed => {
  switch (failure._tag) {
    case "CategoryNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: `No Category ${failure.categoryId} exists. List Categories and use one of their stable ids.`,
        },
        next: categoryRecovery(caller),
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
        next: keywordRuleRecovery(caller),
      });
    case "KeywordRuleLimitReached":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: `A User may retain at most ${failure.maximum} keyword rules. Edit or delete an existing rule before creating another.`,
          fields: [],
        },
        next: keywordRuleRecovery(caller),
      });
    case "KeywordRuleNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: `No keyword rule ${failure.keywordRuleId} belongs to you. List your keyword rules to find an id you can change.`,
        },
        next: keywordRuleRecovery(caller),
      });
  }
};
