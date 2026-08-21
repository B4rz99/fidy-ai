import { Effect, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { type CategoryId } from "~/core/categories/reference";
import { type UserId } from "~/core/identity/reference";
import { findKeywordCategory, findKnownCaptureCategory } from "~/core/categories/rules";
import { categoryIds } from "~/core/categories/taxonomy";
import { selectKeywordRulesInScope } from "./repo";

/** Stand-in for the future model adapter; absence there resolves explicitly to Otros. */
const modelFallback = (): Effect.Effect<CategoryId> => Effect.succeed(categoryIds.otros);

/**
 * Applies explicit and User-rule choices before consulting the model fallback.
 * The returned Category is always present.
 */
export const categorizeCapture = ({
  userId,
  counterparty,
  callerCategory,
}: {
  readonly userId: UserId;
  readonly counterparty: Option.Option<string>;
  readonly callerCategory: Option.Option<CategoryId>;
}): Effect.Effect<CategoryId, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const rules = yield* selectKeywordRulesInScope(userId);
    const keywordCategory = yield* Option.match(counterparty, {
      onNone: () => Effect.succeed(Option.none<CategoryId>()),
      onSome: (knownCounterparty) =>
        findKeywordCategory({ counterparty: knownCounterparty, rules }),
    });
    const known = yield* findKnownCaptureCategory({
      caller: callerCategory,
      keywordRule: keywordCategory,
    });

    return Option.isSome(known) ? known.value : yield* modelFallback();
  });
