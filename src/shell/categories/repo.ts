import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CategoryId } from "~/core/_shared/category";
import { UserId } from "~/core/_shared/user";
import {
  Category,
  type CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  type UpdateKeywordRuleInput,
} from "~/core/categories/model";
import { normalizeCategoryKeyword } from "~/core/categories/rules";

/** Loads Categories in presentation order. Database failures are defects. */
export const listCategories = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: Category,
    execute: () => sql`SELECT id, label FROM categories ORDER BY display_order`,
  })(undefined)
).pipe(Effect.orDie);

/** Looks up public Category metadata by stable identity; absence remains explicit. */
export const findCategory = (categoryId: CategoryId) =>
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

/** Loads only one User's keyword rules in stable creation order. Database failures are defects. */
export const listKeywordRules = (userId: UserId) =>
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

/**
 * Serializes rule decisions for one User inside the current operation transaction. Call before a
 * load-decide-write sequence so duplicate and capacity decisions remain true at insertion.
 */
export const lockKeywordRules = (userId: UserId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`
  ).pipe(Effect.asVoid, Effect.orDie);

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
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: KeywordRuleWrite,
      Result: KeywordRuleRow,
      execute: (row) => sql`
          INSERT INTO keyword_rules (user_id, keyword, normalized_keyword, category_id)
          VALUES (${row.userId}, ${row.keyword}, ${row.normalizedKeyword}, ${row.categoryId})
          RETURNING ${sql.literal(keywordRuleColumns)}
        `,
    })({ ...input, userId, normalizedKeyword: normalizeCategoryKeyword(input.keyword) })
  ).pipe(Effect.orDie);
});

/** Replaces one User-owned rule; a missing or foreign identity returns None without disclosure. */
export const updateKeywordRule = Effect.fn("updateKeywordRule")(function* (
  userId: UserId,
  id: KeywordRuleId,
  input: UpdateKeywordRuleInput
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
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
  ).pipe(Effect.orDie);
});

/** Permanently removes one User-owned rule; foreign and absent identities both return None. */
export const deleteKeywordRule = Effect.fn("deleteKeywordRule")(function* (
  userId: UserId,
  id: KeywordRuleId
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: KeywordRuleId, userId: UserId }),
      Result: Schema.Struct({ id: KeywordRuleId }),
      execute: (row) => sql`
          DELETE FROM keyword_rules WHERE id = ${row.id} AND user_id = ${row.userId} RETURNING id
        `,
    })({ id, userId })
  ).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});
