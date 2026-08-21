import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CategoryId } from "~/core/categories/reference";
import { UserId } from "~/core/identity/reference";
import {
  Category,
  type CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  type UpdateKeywordRuleInput,
} from "~/core/categories/model";
import { normalizeCategoryKeyword } from "~/core/categories/rules";
import { advisoryLockKey } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";

/** Loads Categories in presentation order. Database failures are defects. */
export const selectCategories = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: Category,
    execute: () => sql`SELECT id, label FROM categories ORDER BY display_order`,
  })(undefined)
).pipe(Effect.orDie);

/** Looks up public Category metadata by stable identity; absence remains explicit. */
export const findCategory = (
  categoryId: CategoryId
): Effect.Effect<Option.Option<Category>, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: CategoryId,
      Result: Category,
      execute: (id) => sql`SELECT id, label FROM categories WHERE id = ${id}`,
    })(categoryId)
  ).pipe(Effect.orDie);

const KeywordRuleRow = Schema.Struct({
  id: KeywordRule.fields.id,
  keyword: KeywordRule.fields.keyword,
  categoryId: CategoryId,
  createdAt: Schema.DateTimeUtcFromDate,
  updatedAt: Schema.DateTimeUtcFromDate,
});
const keywordRuleColumns = `id, keyword, category_id AS "categoryId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Loads one User's keyword rules inside the caller's User-scoped transaction. */
export const selectKeywordRulesInScope = (
  userId: UserId
): Effect.Effect<ReadonlyArray<typeof KeywordRuleRow.Type>, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: UserId,
      Result: KeywordRuleRow,
      execute: (owner) => sql`
        SELECT ${sql.literal(keywordRuleColumns)} FROM keyword_rules
        WHERE user_id = ${owner} ORDER BY created_at, id
      `,
    })(userId)
  ).pipe(Effect.orDie);

/** Loads only one User's keyword rules in stable creation order. Database failures are defects. */
export const selectKeywordRules = (
  userId: UserId
): Effect.Effect<ReadonlyArray<typeof KeywordRuleRow.Type>, never, SqlClient.SqlClient> =>
  withUserTransaction(userId, selectKeywordRulesInScope(userId));

/**
 * Serializes one keyword-rule load-decide-write body inside the caller's User-scoped transaction.
 * The caller owns commit or rollback; releasing that transaction releases the slice lock.
 */
export const withKeywordLockInScope = Effect.fn("withKeywordLockInScope")(function* <A, E, R>(
  userId: UserId,
  body: Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  const lockKey = advisoryLockKey.keywordRules(userId);
  yield* sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey.value}, ${lockKey.seed}))
  `.pipe(Effect.orDie);
  return yield* body;
});

const KeywordRuleWrite = Schema.Struct({
  userId: UserId,
  keyword: KeywordRule.fields.keyword,
  normalizedKeyword: Schema.NonEmptyString,
  categoryId: CategoryId,
});

/** Inserts one validated rule inside the caller's User-scoped transaction. */
export const insertKeywordRuleInScope = Effect.fn("insertKeywordRuleInScope")(function* (
  userId: UserId,
  input: CreateKeywordRuleInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: KeywordRuleWrite,
    Result: KeywordRuleRow,
    execute: (row) => sql`
      INSERT INTO keyword_rules (user_id, keyword, normalized_keyword, category_id)
      VALUES (${row.userId}, ${row.keyword}, ${row.normalizedKeyword}, ${row.categoryId})
      RETURNING ${sql.literal(keywordRuleColumns)}
    `,
  })({ ...input, userId, normalizedKeyword: normalizeCategoryKeyword(input.keyword) }).pipe(
    Effect.orDie
  );
});

/** Replaces one User-owned rule inside the caller's transaction; foreign or absent returns None. */
export const updateKeywordRuleInScope = Effect.fn("updateKeywordRuleInScope")(function* (
  userId: UserId,
  id: KeywordRuleId,
  input: UpdateKeywordRuleInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ ...KeywordRuleWrite.fields, id: KeywordRuleId }),
    Result: KeywordRuleRow,
    execute: (row) => sql`
      UPDATE keyword_rules SET keyword = ${row.keyword},
        normalized_keyword = ${row.normalizedKeyword}, category_id = ${row.categoryId},
        updated_at = now()
      WHERE id = ${row.id} AND user_id = ${row.userId}
      RETURNING ${sql.literal(keywordRuleColumns)}
    `,
  })({ ...input, id, userId, normalizedKeyword: normalizeCategoryKeyword(input.keyword) }).pipe(
    Effect.orDie
  );
});

/** Removes one User-owned rule inside the caller's transaction; foreign and absent return None. */
export const deleteKeywordRuleInScope = Effect.fn("deleteKeywordRuleInScope")(function* (
  userId: UserId,
  id: KeywordRuleId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ id: KeywordRuleId, userId: UserId }),
    Result: Schema.Struct({ id: KeywordRuleId }),
    execute: (row) => sql`
      DELETE FROM keyword_rules WHERE id = ${row.id} AND user_id = ${row.userId} RETURNING id
    `,
  })({ id, userId }).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});
