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
import { advisoryLockKey, withUserLock } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";

/** Loads Categories in presentation order. Database failures are defects. */
export const listCategories = Effect.flatMap(SqlClient.SqlClient, (sql) =>
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
export const listKeywordRulesInScope = (
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
export const listKeywordRules = (
  userId: UserId
): Effect.Effect<ReadonlyArray<typeof KeywordRuleRow.Type>, never, SqlClient.SqlClient> =>
  withUserTransaction(userId, listKeywordRulesInScope(userId));

/**
 * Runs one keyword-rule decision under a User-scoped, slice-namespaced lock. The lock covers the
 * supplied load-decide-write body and cannot be acquired independently of its transaction.
 */
export const withKeywordLock = Effect.fn("withKeywordLock")(function* <A, E, R>(
  userId: UserId,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserLock(userId, advisoryLockKey.keywordRules(userId), body);
});

const KeywordRuleWrite = Schema.Struct({
  userId: UserId,
  keyword: KeywordRule.fields.keyword,
  normalizedKeyword: Schema.NonEmptyString,
  categoryId: CategoryId,
});

/** Inserts one rule for the explicit User after the handler has serialized and validated it. */
export const insertKeywordRule = Effect.fn("insertKeywordRule")(function* (
  userId: UserId,
  input: CreateKeywordRuleInput
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOne({
        Request: KeywordRuleWrite,
        Result: KeywordRuleRow,
        execute: (row) => sql`
          INSERT INTO keyword_rules (user_id, keyword, normalized_keyword, category_id)
          VALUES (${row.userId}, ${row.keyword}, ${row.normalizedKeyword}, ${row.categoryId})
          RETURNING ${sql.literal(keywordRuleColumns)}
        `,
      })({ ...input, userId, normalizedKeyword: normalizeCategoryKeyword(input.keyword) })
    ).pipe(Effect.orDie)
  );
});

/** Replaces one User-owned rule; a missing or foreign identity returns None without disclosure. */
export const updateKeywordRule = Effect.fn("updateKeywordRule")(function* (
  userId: UserId,
  id: KeywordRuleId,
  input: UpdateKeywordRuleInput
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: Schema.Struct({ ...KeywordRuleWrite.fields, id: KeywordRuleId }),
        Result: KeywordRuleRow,
        execute: (row) => sql`
          UPDATE keyword_rules SET keyword = ${row.keyword},
            normalized_keyword = ${row.normalizedKeyword}, category_id = ${row.categoryId},
            updated_at = now()
          WHERE id = ${row.id} AND user_id = ${row.userId}
          RETURNING ${sql.literal(keywordRuleColumns)}
        `,
      })({ ...input, id, userId, normalizedKeyword: normalizeCategoryKeyword(input.keyword) })
    ).pipe(Effect.orDie)
  );
});

/** Permanently removes one User-owned rule; foreign and absent identities both return None. */
export const deleteKeywordRule = Effect.fn("deleteKeywordRule")(function* (
  userId: UserId,
  id: KeywordRuleId
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: Schema.Struct({ id: KeywordRuleId, userId: UserId }),
        Result: Schema.Struct({ id: KeywordRuleId }),
        execute: (row) => sql`
          DELETE FROM keyword_rules WHERE id = ${row.id} AND user_id = ${row.userId} RETURNING id
        `,
      })({ id, userId })
    ).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie)
  );
});
