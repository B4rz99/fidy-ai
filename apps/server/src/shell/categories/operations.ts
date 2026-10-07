import { categoryResponseFromRows, categoryRowsQuery } from "~/shell/categories/internal/query";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { CategoryReadInput, ListCategoriesResponse } from "./contract";
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

/** Maps actionable Category failures to the complete canonical API failure vocabulary. */
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
}

/** Safe public failure when Category authority is unavailable. */
export const categoryUnavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "Categories are temporarily unavailable. Retry later.",
    },
    next: [],
  });

/** The bounded canonical Category read shared by portable HTTP and hosted execution. */
export const listCategoriesResponse: Effect.Effect<
  typeof ListCategoriesResponse.Type,
  Unavailable,
  SqlClient.SqlClient
> = Effect.flatMap(SqlClient.SqlClient, (sql) => {
  const query = categoryRowsQuery();
  return sql.unsafe<Record<string, unknown>>(query.sql, query.params);
}).pipe(
  Effect.mapError(categoryUnavailable),
  Effect.flatMap((rows) => Effect.fromOption(categoryResponseFromRows(rows), categoryUnavailable))
);

/**
 * Prepare the canonical bounded, ordered Category projection in a caller-owned native unit.
 * Only the prepared action escapes; the owner retains SQL and row policy. Canonical callers compose
 * their live-authority audit in the same unit before decoding or releasing the result.
 */
export const prepareCategoryRead = ({ db, authority }: CategoryReadInput): D1PreparedStatement => {
  const query = categoryRowsQuery(Option.getOrUndefined(authority));
  return db.prepare(query.sql).bind(...query.params);
};

/** Decode a completed Category read; malformed or oversized projections are never partially returned. */
export const decodeCategoryRead = (
  result: unknown
): Option.Option<typeof ListCategoriesResponse.Type> => categoryResponseFromRows(result);
