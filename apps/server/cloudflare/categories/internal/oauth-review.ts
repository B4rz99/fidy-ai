import { type Cause, Effect, Option, Schema } from "effect";
import {
  CategoryId,
  CategoryKeyword,
  CategoryLabel,
  KeywordRuleId,
  maximumKeywordRulesPerUser,
} from "../../../src/core/categories/contract";
import { CategoriesGroup } from "../../../src/shell/categories/contract";
import { getOperationPolicy } from "../../../src/shell/canonical-policy/contract";
import { type TransactionCaller, isOAuthCaller } from "../../canonical-work/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { KeywordRuleOutcome } from "../contract";

const RuleSnapshot = Schema.Struct({
  id: KeywordRuleId,
  keyword: CategoryKeyword,
  normalized_keyword: Schema.String,
  category_id: CategoryId,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const CategorySnapshot = Schema.Struct({
  id: CategoryId,
  label: CategoryLabel,
  display_order: Schema.Int,
});
const Snapshot = Schema.Struct({
  rules: Schema.Array(RuleSnapshot),
  categories: Schema.Array(CategorySnapshot),
});
type Snapshot = typeof Snapshot.Type;
const RulesJson = Schema.fromJsonString(Schema.Array(RuleSnapshot));
const CategoriesJson = Schema.fromJsonString(Schema.Array(CategorySnapshot));
const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));
type ReviewInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: KeywordRuleOutcome;
}>;

const needsReview = (input: ReviewInput): boolean => {
  if (!isOAuthCaller(input.subject)) {
    return false;
  }
  switch (input.outcome.operation) {
    case "categories.createKeywordRule":
      return (
        getOperationPolicy(CategoriesGroup.endpoints.createKeywordRule).agentConfirmation ===
        "required"
      );
    case "categories.updateKeywordRule":
      return (
        getOperationPolicy(CategoriesGroup.endpoints.updateKeywordRule).agentConfirmation ===
        "required"
      );
    case "categories.deleteKeywordRule":
      return (
        getOperationPolicy(CategoriesGroup.endpoints.deleteKeywordRule).agentConfirmation ===
        "required"
      );
  }
};
const snapshotGuard = (userId: string, snapshot: Snapshot): OwnedStatement => ({
  sql: `SELECT 1 WHERE (SELECT count(*) FROM keyword_rules WHERE user_id = ?) = ?
    AND NOT EXISTS (SELECT 1 FROM json_each(?) AS expected WHERE NOT EXISTS (
      SELECT 1 FROM keyword_rules AS rule WHERE rule.user_id = ?
      AND rule.id = json_extract(expected.value, '$.id')
      AND rule.keyword = json_extract(expected.value, '$.keyword')
      AND rule.normalized_keyword = json_extract(expected.value, '$.normalized_keyword')
      AND rule.category_id = json_extract(expected.value, '$.category_id')
      AND rule.created_at = json_extract(expected.value, '$.created_at')
      AND rule.updated_at = json_extract(expected.value, '$.updated_at')))
    AND (SELECT count(*) FROM categories) = ?
    AND NOT EXISTS (SELECT 1 FROM json_each(?) AS expected WHERE NOT EXISTS (
      SELECT 1 FROM categories AS category WHERE category.id = json_extract(expected.value, '$.id')
      AND category.label = json_extract(expected.value, '$.label')
      AND category.display_order = json_extract(expected.value, '$.display_order')))`,
  params: [
    userId,
    snapshot.rules.length,
    Schema.encodeSync(RulesJson)(snapshot.rules),
    userId,
    snapshot.categories.length,
    Schema.encodeSync(CategoriesJson)(snapshot.categories),
  ],
});
const exactEffect = (outcome: KeywordRuleOutcome, snapshot: Snapshot): string => {
  const previous = Option.fromUndefinedOr(
    snapshot.rules.find((rule) => rule.id === outcome.ruleId)
  );
  const before = Option.match(previous, {
    onNone: () => "ausente",
    onSome: (rule) => `${quoted(rule.keyword)}, categoría ${rule.category_id}`,
  });
  if (outcome.operation === "categories.deleteKeywordRule") {
    return `Eliminar la regla ${outcome.ruleId}: ${before}. Solo afecta capturas futuras; no cambia Transacciones existentes.`;
  }
  const target = Option.fromUndefinedOr(
    snapshot.categories.find((category) => category.id === outcome.categoryId)
  );
  const category = Option.match(target, {
    onNone: () => "ausente",
    onSome: (value) => `${quoted(value.label)} (${value.id})`,
  });
  return `Reemplazar la regla ${outcome.ruleId}: ${before} por la palabra clave ${quoted(outcome.keyword)} y la categoría ${category}. Solo afecta capturas futuras; no cambia Transacciones existentes.`;
};

export const ruleOAuthReview = (
  input: ReviewInput
): Effect.Effect<Option.Option<OAuthMutationReview>, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    if (!needsReview(input)) {
      return Option.none();
    }
    const rulesResult = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT id,keyword,normalized_keyword,category_id,created_at,updated_at FROM keyword_rules WHERE user_id = ? ORDER BY id LIMIT ${maximumKeywordRulesPerUser + 1}`
        )
        .bind(input.subject.userId)
        .all()
    );
    const rules = yield* Schema.decodeUnknownEffect(
      Schema.Array(RuleSnapshot).check(Schema.isMaxLength(maximumKeywordRulesPerUser))
    )(rulesResult.results);
    const categoryResult = yield* Effect.tryPromise(() =>
      input.db.prepare("SELECT id,label,display_order FROM categories ORDER BY id LIMIT 101").all()
    );
    const categories = yield* Schema.decodeUnknownEffect(
      Schema.Array(CategorySnapshot).check(Schema.isMaxLength(100))
    )(categoryResult.results);
    const snapshot = { rules, categories };
    return Option.some(
      oauthMutationReview({
        db: input.db,
        revision: yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot),
        effect: exactEffect(input.outcome, snapshot),
        guard: snapshotGuard(input.subject.userId, snapshot),
      })
    );
  });
