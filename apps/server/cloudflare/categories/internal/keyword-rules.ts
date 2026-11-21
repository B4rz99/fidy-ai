import { Option, Schema } from "effect";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import { normalizeSearchText as normalizeCategoryKeyword } from "../../../src/core/search/operations";
import { KeywordRule, maximumKeywordRulesPerUser } from "../../../src/core/categories/contract";

import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

import type { CategoryAuditOperation } from "../contract";

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

export const keywordRulesFromRows = (rows: unknown): Option.Option<ReadonlyArray<KeywordRule>> =>
  Option.flatMap(Schema.decodeUnknownOption(Schema.Array(RuleRow))(rows), (rules) =>
    rules.length <= maximumKeywordRulesPerUser ? Option.some(rules) : Option.none()
  );

export const keywordRuleFromRows = (row: unknown): Option.Option<KeywordRule> =>
  Schema.decodeUnknownOption(RuleRow)(row);

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

export const recordBrowserKeywordRuleRead = (input: BrowserKeywordRuleWork): OwnedStatement =>
  browserKeywordRuleAudit(input, false);
