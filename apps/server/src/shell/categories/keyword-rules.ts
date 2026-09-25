import { Option, Schema } from "effect";
import { KeywordRule } from "~/core/categories/model";
import { maximumKeywordRulesPerUser } from "~/core/categories/rules";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";

/** Every Category operation an accepted browser call may be attributable to. */
export type CategoryAuditOperation =
  | "categories.listCategories"
  | "categories.listKeywordRules"
  | "categories.createKeywordRule"
  | "categories.updateKeywordRule"
  | "categories.deleteKeywordRule";

/** The canonical mutation ids that retain one User's keyword-rule evidence. */
export type KeywordRuleOperation = Extract<
  CategoryAuditOperation,
  "categories.createKeywordRule" | "categories.updateKeywordRule" | "categories.deleteKeywordRule"
>;

/** The keyword-rule mutation ids the Core dispatch owns, for owner dispatch without a cascade. */
export const keywordRuleOperationIds = [
  "categories.createKeywordRule",
  "categories.updateKeywordRule",
  "categories.deleteKeywordRule",
] as const satisfies ReadonlyArray<KeywordRuleOperation>;

/** A live credential re-evaluated inside the same D1 unit as the rule write. */
type Authority = Readonly<{
  table: "pats" | "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

const ruleColumns = `id,keyword,category_id AS "categoryId",created_at AS "createdAt",updated_at AS "updatedAt"`;
// The extra row detects a corrupt overflow instead of silently dropping a capture-time rule.
const boundedRuleCount = maximumKeywordRulesPerUser + 1;

/** One User's rules in stable creation order, for the capture-time precedence decision. */
export const keywordRulesQuery = ({ userId }: Readonly<{ userId: string }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ?
    ORDER BY created_at, id LIMIT ${boundedRuleCount}`,
  params: [userId],
});

/** The same owned rules, re-checking a live caller inside the reading statement. */
export const protectedKeywordRulesQuery = ({
  userId,
  authority,
}: Readonly<{ userId: string; authority: Authority }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ?
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ORDER BY created_at, id LIMIT ${boundedRuleCount}`,
  params: [userId, ...authority.bindings],
});

/** Decode a bounded rule list; an over-limit result is unavailable rather than truncated. */
export const keywordRulesFromRows = (rows: unknown): Option.Option<ReadonlyArray<KeywordRule>> =>
  Option.flatMap(Schema.decodeUnknownOption(Schema.Array(KeywordRule))(rows), (rules) =>
    rules.length <= maximumKeywordRulesPerUser ? Option.some(rules) : Option.none()
  );

/** Decode one owned rule for the canonical mutation response. */
export const keywordRuleFromRows = (row: unknown): Option.Option<KeywordRule> =>
  Schema.decodeUnknownOption(KeywordRule)(row);

/** One owned rule by stable id; a foreign or absent id returns no row. */
export const keywordRuleQuery = ({
  userId,
  id,
}: Readonly<{ userId: string; id: string }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ? AND id = ?`,
  params: [userId, id],
});

/** Facts a validated rule write needs before it can be composed into a D1 unit. */
export type KeywordRuleWrite = Readonly<{
  id: string;
  userId: string;
  keyword: string;
  normalizedKeyword: string;
  categoryId: string;
  timestamp: string;
  authority: Authority;
}>;

/** Facts a validated rule removal needs before it can be composed into a D1 unit. */
export type KeywordRuleRemoval = Readonly<{
  id: string;
  userId: string;
  authority: Authority;
}>;

/**
 * Insert one rule only for a live caller and an existing stable Category. Both facts are
 * re-evaluated inside the writing statement, so a category or credential that disappeared
 * between validation and commit changes no row.
 */
export const insertKeywordRule = (input: KeywordRuleWrite): OwnedStatement => ({
  sql: `INSERT INTO keyword_rules (id,user_id,keyword,normalized_keyword,category_id,created_at,updated_at)
    SELECT ?,?,?,?,id,?,? FROM categories WHERE id = ?
    AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
  params: [
    input.id,
    input.userId,
    input.keyword,
    input.normalizedKeyword,
    input.timestamp,
    input.timestamp,
    input.categoryId,
    ...input.authority.bindings,
  ],
});

/** Replace one User-owned rule under the same live credential and Category guarantees. */
export const replaceKeywordRule = (input: KeywordRuleWrite): OwnedStatement => ({
  sql: `UPDATE keyword_rules SET keyword = ?, normalized_keyword = ?, category_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM categories WHERE id = ?)
    AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
  params: [
    input.keyword,
    input.normalizedKeyword,
    input.categoryId,
    input.timestamp,
    input.id,
    input.userId,
    input.categoryId,
    ...input.authority.bindings,
  ],
});

/** Remove one User-owned rule; a foreign or absent id changes no row. */
export const removeKeywordRule = (input: KeywordRuleRemoval): OwnedStatement => ({
  sql: `DELETE FROM keyword_rules WHERE id = ? AND user_id = ?
    AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
  params: [input.id, input.userId, ...input.authority.bindings],
});

type BrowserKeywordRuleWork = Readonly<{
  subject: Readonly<{ id: string; userId: string; digest: Uint8Array }>;
  operation: CategoryAuditOperation;
  id: string;
  current: number;
}>;

const browserKeywordRuleAudit = (
  { subject, operation, id, current }: BrowserKeywordRuleWork,
  afterWrite: boolean
): OwnedStatement => {
  const authority = liveWebSessionAuthority({ subject, current });
  return {
    sql: `INSERT INTO category_audit (id,user_id,session_id,operation,occurred_at_ms)
      SELECT ?, user_id, ?, ?, ? FROM ${authority.table}
      WHERE ${authority.predicate}${afterWrite ? " AND changes() = 1" : ""}`,
    params: [id, subject.id, operation, current, ...authority.bindings],
  };
};

/** One accepted browser rule change, attributable to its exact live WebSession. */
export const recordBrowserKeywordRuleWork = (input: BrowserKeywordRuleWork): OwnedStatement =>
  browserKeywordRuleAudit(input, true);

/** One accepted browser rule read, attributable to its exact live WebSession. */
export const recordBrowserKeywordRuleRead = (input: BrowserKeywordRuleWork): OwnedStatement =>
  browserKeywordRuleAudit(input, false);

/** A skipped guarded rule audit aborts the whole keyword-rule D1 batch. */
export const categoryMutationCompletion = `INSERT INTO category_mutation_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
