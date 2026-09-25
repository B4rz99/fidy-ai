import {
  type CategoryId,
  type KeywordRule,
  keywordRulesFromRows,
  keywordRulesQuery,
} from "@fidy/server/categories";
import { Effect, Option } from "effect";

/** The status a declared `ValidationFailed` keyword-rule refusal answers with. */
export const HTTP_BAD_REQUEST = 400;
/** The status a declared `NotFound` keyword-rule refusal answers with. */
export const HTTP_NOT_FOUND = 404;

/** The one JSON response header set every keyword-rule route and refusal answers with. */
export const keywordRuleJsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

/** The caller's own retained rules, or None when the bounded projection cannot be decoded. */
export const findOwnedKeywordRules = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<
  Option.Option<ReadonlyArray<KeywordRule>>
> => {
  const query = keywordRulesQuery({ userId });
  return db
    .prepare(query.sql)
    .bind(...query.params)
    .all()
    .then((result) => keywordRulesFromRows(result.results));
};

/** True while the named stable Category still exists, or None when its read cannot decide. */
export const findExistingCategory = ({
  db,
  categoryId,
}: Readonly<{ db: D1Database; categoryId: CategoryId }>): Effect.Effect<Option.Option<boolean>> =>
  Effect.tryPromise(() =>
    db.prepare("SELECT 1 FROM categories WHERE id = ?").bind(categoryId).first()
  ).pipe(
    Effect.map((category) => Option.some(category !== null)),
    Effect.orElseSucceed(() => Option.none())
  );
