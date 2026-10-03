import { categoryResponseFromRows, categoryRowsQuery } from "~/shell/categories/internal/query";
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import type {
  CategoryFailure,
  CategoryNotFound,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
} from "~/core/categories/contract";
import type { SuggestedOperationCaller } from "~/shell/canonical-operations/operations";
import type { NotFound, Unavailable, ValidationFailed } from "~/shell/public-http/contract";
import { toApiFailure as projectFailure } from "~/shell/categories/internal/errors";
import {
  listCategoriesResponse as listResponse,
  categoryUnavailable as unavailable,
} from "~/shell/categories/internal/list-categories";
import type { CategoryReadInput, ListCategoriesResponse } from "./contract";

type CategoryFailureInput<Failure extends CategoryFailure> = Readonly<{
  failure: Failure;
  caller: SuggestedOperationCaller;
}>;
/** Map the owner's closed failures to caller-scoped canonical recovery suggestions. */
export function toApiFailure(
  input: CategoryFailureInput<CategoryNotFound | KeywordRuleNotFound>
): NotFound;
export function toApiFailure(
  input: CategoryFailureInput<KeywordRuleAlreadyExists | KeywordRuleLimitReached>
): ValidationFailed;
export function toApiFailure(
  input: CategoryFailureInput<CategoryFailure>
): NotFound | ValidationFailed;
export function toApiFailure(
  input: CategoryFailureInput<CategoryFailure>
): NotFound | ValidationFailed {
  return projectFailure(input);
}
/** The bounded canonical Category read shared by portable HTTP and hosted execution. */
export const listCategoriesResponse: Effect.Effect<
  typeof ListCategoriesResponse.Type,
  Unavailable,
  SqlClient.SqlClient
> = Effect.suspend(() => listResponse);
/** Safe public failure when Category authority is unavailable. */
export const categoryUnavailable = (): Unavailable => unavailable();

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
