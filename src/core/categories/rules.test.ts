import { expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { CategoryId } from "./reference";
import {
  CategoryKeyword,
  CreateKeywordRuleInput,
  KeywordRuleId,
  normalizeCategoryKeyword,
} from "./model";
import {
  canCreateKeywordRule,
  findKeywordCategory,
  findKnownCaptureCategory,
  hasKeywordRule,
  maximumKeywordRulesPerUser,
} from "./rules";

const domicilios = CategoryId.make("11111111-1111-4111-8111-111111111111");
const mercado = CategoryId.make("22222222-2222-4222-8222-222222222222");
const firstRuleId = KeywordRuleId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const secondRuleId = KeywordRuleId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

const categoryRule = (id: KeywordRuleId, keyword: string, categoryId: CategoryId = domicilios) => ({
  id,
  keyword,
  categoryId,
});

it("normalizes Category keywords without changing surrounding content", () => {
  expect(normalizeCategoryKeyword("  RÁPPI Ñ  ")).toBe("  rappi n  ");
});

it("rejects a Category keyword erased by normalization at the keyword root", () => {
  const result = Schema.decodeUnknownResult(CategoryKeyword)("́");

  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(String(result.failure)).toBe(
      "SchemaError(Expected a keyword containing a letter or number)"
    );
  }
});

it("derives create-rule fields without persistence-assigned facts", () => {
  expect(Object.keys(CreateKeywordRuleInput.fields)).toEqual(["keyword", "categoryId"]);
});

it.effect("uses the most specific matching user keyword without caring about case or accents", () =>
  Effect.gen(function* () {
    const category = yield* findKeywordCategory({
      counterparty: "RÁPPI Turbo Bogotá",
      rules: [
        categoryRule(firstRuleId, CategoryKeyword.make("rappi")),
        categoryRule(secondRuleId, CategoryKeyword.make("Rappi Turbo"), mercado),
      ],
    });

    expect(Option.getOrUndefined(category)).toBe(mercado);
  })
);

it.effect("uses lexical rule identity for equal-length ties and returns None without a match", () =>
  Effect.gen(function* () {
    const earlier = CategoryId.make("33333333-3333-4333-8333-333333333333");
    const category = yield* findKeywordCategory({
      counterparty: "ab tienda cd",
      rules: [
        categoryRule(secondRuleId, CategoryKeyword.make("cd"), mercado),
        categoryRule(firstRuleId, CategoryKeyword.make("ab"), earlier),
      ],
    });
    const absent = yield* findKeywordCategory({
      counterparty: "sin coincidencia",
      rules: [categoryRule(firstRuleId, CategoryKeyword.make("rappi"))],
    });

    expect(Option.getOrUndefined(category)).toBe(earlier);
    expect(Option.isNone(absent)).toBe(true);
  })
);

it.effect("detects only a normalized duplicate when no rule is excluded", () =>
  Effect.gen(function* () {
    const rules = [categoryRule(firstRuleId, "Éxito"), categoryRule(secondRuleId, "Rappi")];

    expect(yield* hasKeywordRule({ keyword: "exito", rules, excluding: Option.none() })).toBe(true);
    expect(yield* hasKeywordRule({ keyword: "Carulla", rules, excluding: Option.none() })).toBe(
      false
    );
    expect(yield* hasKeywordRule({ keyword: "exito", rules: [], excluding: Option.none() })).toBe(
      false
    );
  })
);

it.effect("excludes exactly the edited rule while checking duplicate keywords", () =>
  Effect.gen(function* () {
    const matching = categoryRule(firstRuleId, "Éxito");
    const other = categoryRule(secondRuleId, "Rappi");

    expect(
      yield* hasKeywordRule({
        keyword: "exito",
        rules: [matching, other],
        excluding: Option.some(firstRuleId),
      })
    ).toBe(false);
    expect(
      yield* hasKeywordRule({
        keyword: "exito",
        rules: [matching],
        excluding: Option.some(secondRuleId),
      })
    ).toBe(true);
    expect(
      yield* hasKeywordRule({
        keyword: "exito",
        rules: [matching, categoryRule(secondRuleId, "EXITO")],
        excluding: Option.some(firstRuleId),
      })
    ).toBe(true);
  })
);

it.effect("allows the hundredth keyword rule but rejects the hundred-and-first", () =>
  Effect.gen(function* () {
    const retainedRules = Array.from({ length: maximumKeywordRulesPerUser }, (_, index) =>
      categoryRule(firstRuleId, `rule-${index}`)
    );

    expect(yield* canCreateKeywordRule(retainedRules.slice(0, -1))).toBe(true);
    expect(yield* canCreateKeywordRule(retainedRules)).toBe(false);
    expect(
      yield* canCreateKeywordRule([...retainedRules, categoryRule(firstRuleId, "overflow")])
    ).toBe(false);
  })
);

it.effect("prefers an explicit Category, then a User rule, before leaving capture unresolved", () =>
  Effect.gen(function* () {
    const explicit = yield* findKnownCaptureCategory({
      caller: Option.some(mercado),
      keywordRule: Option.some(domicilios),
    });
    const fromRule = yield* findKnownCaptureCategory({
      caller: Option.none<CategoryId>(),
      keywordRule: Option.some(domicilios),
    });
    const absent = yield* findKnownCaptureCategory({
      caller: Option.none<CategoryId>(),
      keywordRule: Option.none<CategoryId>(),
    });

    expect(Option.getOrUndefined(explicit)).toBe(mercado);
    expect(Option.getOrUndefined(fromRule)).toBe(domicilios);
    expect(Option.isNone(absent)).toBe(true);
  })
);
