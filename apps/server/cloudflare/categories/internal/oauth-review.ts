import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import {
  CategoryId,
  CategoryKeyword,
  CategoryLabel,
  KeywordRuleId,
  maximumKeywordRulesPerUser,
} from "../../../src/core/categories/contract";
import type { KeywordRuleOutcome } from "../contract";

const RuleSnapshot = Schema.Struct({
  id: KeywordRuleId,
  keyword: CategoryKeyword,
  category_id: CategoryId,
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int,
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

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));

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

export const localRuleReview = Effect.fn(function* (user: string, outcome: KeywordRuleOutcome) {
  const sql = yield* SqliteClient;

  const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)({
    rules:
      yield* sql`SELECT id,keyword,category_id,created_at_ms,updated_at_ms FROM keyword_rules WHERE user_id=${user} ORDER BY id LIMIT ${maximumKeywordRulesPerUser + 1}`,
    categories: yield* sql`SELECT id,label,display_order FROM categories ORDER BY id LIMIT 101`,
  });

  return {
    revision: yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot),
    effect: exactEffect(outcome, snapshot),
  };
});
