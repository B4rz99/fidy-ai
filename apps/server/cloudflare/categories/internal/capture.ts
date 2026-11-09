import { Effect, Option } from "effect";
import type { CategoryId } from "../../../src/core/categories/contract";
import { categorizeCapture } from "../../../src/core/categories/operations";
import { type CaptureCategoryInput, CategoriesUnavailable } from "../contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { keywordRulesFromRows, selectedKeywordRulesQuery } from "./keyword-rules";
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

/** Decode once and resolve captures without further storage work in a protected read. */
export const prepareCaptureCategories = ({
  db,
  users,
}: Readonly<{ db: D1Database; users: OwnedStatement }>): Readonly<{
  statement: D1PreparedStatement;
  decode: (
    rows: unknown
  ) => (
    captures: ReadonlyArray<CaptureCategoryInput>
  ) => Effect.Effect<ReadonlyArray<CategoryId>, CategoriesUnavailable>;
}> => {
  const query = selectedKeywordRulesQuery(users);
  return {
    statement: db.prepare(query.sql).bind(...query.params),
    decode: (rows: unknown) => {
      const rules = keywordRulesFromRows(rows);
      return (
        captures: ReadonlyArray<CaptureCategoryInput>
      ): Effect.Effect<ReadonlyArray<CategoryId>, CategoriesUnavailable> => {
        const selected = captures.some((input) => Option.isSome(input.counterparty))
          ? rules
          : Option.some([]);
        return Option.isNone(selected) || captures.length > maximumCaptures
          ? Effect.fail(new CategoriesUnavailable())
          : Effect.forEach(captures, (input) =>
              categorizeCapture({ ...input, rules: selected.value })
            );
      };
    },
  };
};
