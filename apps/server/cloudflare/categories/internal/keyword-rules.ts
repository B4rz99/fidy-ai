import type { OAuthAuthority } from "../../../src/shell/oauth-agents/contract";
import { Option, Schema } from "effect";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import { normalizeSearchText as normalizeCategoryKeyword } from "../../../src/core/search/operations";
import { KeywordRule, maximumKeywordRulesPerUser } from "../../../src/core/categories/contract";

import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

import type { CategoryAuditOperation } from "../contract";

type Authority = Readonly<{
  table: "pats" | "web_sessions" | "oauth_credentials" | "hosted_turns";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

const ruleColumns = `id,keyword,category_id AS "categoryId",created_at_ms AS "createdAt",updated_at_ms AS "updatedAt"`;
const RuleRow = KeywordRule.mapFields((fields) => ({
  ...fields,
  keyword: fields.keyword.check(
    Schema.makeFilter(
      (keyword) => keyword === normalizeCategoryKeyword(keyword) || "Expected a canonical keyword"
    )
  ),
  createdAt: Schema.DateTimeUtcFromMillis,
  updatedAt: Schema.DateTimeUtcFromMillis,
}));
const boundedRuleCount = maximumKeywordRulesPerUser + 1;

export const keywordRulesQuery = ({ userId }: Readonly<{ userId: string }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ?
    ORDER BY created_at_ms, id LIMIT ${boundedRuleCount}`,
  params: [userId],
});

export const selectedKeywordRulesQuery = (users: OwnedStatement): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id IN (SELECT userId FROM (${users.sql}))
    ORDER BY created_at_ms, id LIMIT ${boundedRuleCount}`,
  params: users.params,
});

export const protectedKeywordRulesQuery = ({
  userId,
  authority,
}: Readonly<{ userId: string; authority: Authority | OAuthAuthority }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ?
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ORDER BY created_at_ms, id LIMIT ${boundedRuleCount}`,
  params: [userId, ...authority.bindings],
});

export const keywordRulesFromRows = (rows: unknown): Option.Option<ReadonlyArray<KeywordRule>> =>
  Option.flatMap(Schema.decodeUnknownOption(Schema.Array(RuleRow))(rows), (rules) =>
    rules.length <= maximumKeywordRulesPerUser ? Option.some(rules) : Option.none()
  );

export const keywordRuleFromRows = (row: unknown): Option.Option<KeywordRule> =>
  Schema.decodeUnknownOption(RuleRow)(row);

export const keywordRuleQuery = ({
  userId,
  id,
}: Readonly<{ userId: string; id: string }>): OwnedStatement => ({
  sql: `SELECT ${ruleColumns} FROM keyword_rules WHERE user_id = ? AND id = ?`,
  params: [userId, id],
});

export type KeywordRuleWrite = Readonly<{
  id: string;
  userId: string;
  keyword: string;
  categoryId: string;
  timestamp: number;
  authority: Authority;
}>;

export type KeywordRuleRemoval = Readonly<{
  id: string;
  userId: string;
  authority: Authority;
}>;

export const insertKeywordRule = (input: KeywordRuleWrite): OwnedStatement => ({
  sql: `INSERT OR IGNORE INTO keyword_rules (id,user_id,keyword,category_id,created_at_ms,updated_at_ms)
    SELECT ?,?,?,id,?,? FROM categories WHERE id = ?
    AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
  params: [
    input.id,
    input.userId,
    input.keyword,
    input.timestamp,
    input.timestamp,
    input.categoryId,
    ...input.authority.bindings,
  ],
});

export const replaceKeywordRule = (input: KeywordRuleWrite): OwnedStatement => ({
  sql: `UPDATE OR IGNORE keyword_rules SET keyword = ?, category_id = ?, updated_at_ms = ?
    WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM categories WHERE id = ?)
    AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`,
  params: [
    input.keyword,
    input.categoryId,
    input.timestamp,
    input.id,
    input.userId,
    input.categoryId,
    ...input.authority.bindings,
  ],
});

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
  return recordAuthorizedCall({
    authority,
    id,
    operation,
    outcome: "success",
    current,
    afterOwnerWrite: afterWrite,
  });
};

export const recordBrowserKeywordRuleWork = (input: BrowserKeywordRuleWork): OwnedStatement =>
  browserKeywordRuleAudit(input, true);

export const recordBrowserKeywordRuleRead = (input: BrowserKeywordRuleWork): OwnedStatement =>
  browserKeywordRuleAudit(input, false);
