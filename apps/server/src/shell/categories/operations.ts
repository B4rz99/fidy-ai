import { categoryResponseFromRows } from "~/shell/categories/internal/query";
import { Effect, Match, type Option } from "effect";
import { listLaunchCategories } from "~/core/categories/operations";
import type { ListCategoriesResponse } from "./contract";
import {
  type CategoryFailure,
  type CategoryNotFound,
  type KeywordRuleAlreadyExists,
  type KeywordRuleLimitReached,
  type KeywordRuleNotFound,
} from "~/core/categories/contract";
import {
  NotFound,
  type SuggestedOperation,
  Unavailable,
  ValidationFailed,
} from "~/shell/public-http/contract";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/canonical-operations/operations";

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

type CategoryFailureInput<Failure extends CategoryFailure> = Readonly<{
  failure: Failure;
  caller: SuggestedOperationCaller;
}>;

export function toApiFailure(
  input: CategoryFailureInput<CategoryNotFound | KeywordRuleNotFound>
): NotFound;
export function toApiFailure(
  input: CategoryFailureInput<KeywordRuleAlreadyExists | KeywordRuleLimitReached>
): ValidationFailed;
export function toApiFailure(
  input: CategoryFailureInput<CategoryFailure>
): NotFound | ValidationFailed;
export function toApiFailure({
  failure,
  caller,
}: CategoryFailureInput<CategoryFailure>): NotFound | ValidationFailed {
  return Match.valueTags(failure, {
    CategoryNotFound: (failure) =>
      NotFound.make({
        error: {
          code: "not_found",
          message: `No Category ${failure.categoryId} exists. List Categories and use one of their stable ids.`,
        },
        next: categoryRecovery(caller),
      }),
    KeywordRuleAlreadyExists: (failure) =>
      ValidationFailed.make({
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
      }),
    KeywordRuleLimitReached: (failure) =>
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: `A User may retain at most ${failure.maximum} keyword rules. Edit or delete an existing rule before creating another.`,
          fields: [],
        },
        next: keywordRuleRecovery(caller),
      }),
    KeywordRuleNotFound: (failure) =>
      NotFound.make({
        error: {
          code: "not_found",
          message: `No keyword rule ${failure.keywordRuleId} belongs to you. List your keyword rules to find an id you can change.`,
        },
        next: keywordRuleRecovery(caller),
      }),
  });
}

export const categoryUnavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "Categories are temporarily unavailable. Retry later.",
    },
    next: [],
  });

export const listCategoriesResponse: Effect.Effect<typeof ListCategoriesResponse.Type> =
  Effect.sync(() => ({ data: listLaunchCategories(), next: [] }));

export const decodeCategoryRead = (
  result: unknown
): Option.Option<typeof ListCategoriesResponse.Type> => categoryResponseFromRows(result);
