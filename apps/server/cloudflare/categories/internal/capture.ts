import { Effect, Option } from "effect";
import type { CategoryId } from "../../../src/core/categories/reference";
import { categorizeCapture } from "../../../src/core/categories/operations";
import { type CaptureCategoryInput, CategoriesUnavailable } from "../contract";
import { findOwnedKeywordRules } from "./keyword-rule-shared";

const maximumCaptures = 100;
/** Resolve a bounded capture chunk against one explicit User's current instruction snapshot. */
export const captureCategories = ({
  db,
  userId,
  captures,
}: Readonly<{
  db: D1Database;
  userId: string;
  captures: ReadonlyArray<CaptureCategoryInput>;
}>): Effect.Effect<ReadonlyArray<CategoryId>, CategoriesUnavailable> =>
  Effect.gen(function* () {
    if (captures.length > maximumCaptures) return yield* new CategoriesUnavailable();
    const rules = captures.some((input) => Option.isSome(input.counterparty))
      ? yield* Effect.tryPromise({
          try: () => findOwnedKeywordRules({ db, userId }),
          catch: () => new CategoriesUnavailable(),
        })
      : Option.some([]);
    if (Option.isNone(rules)) return yield* new CategoriesUnavailable();
    return yield* Effect.forEach(captures, (input) =>
      categorizeCapture({ ...input, rules: rules.value })
    );
  });
