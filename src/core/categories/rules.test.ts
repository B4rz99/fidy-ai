import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { CategoryId } from "./reference";
import { CategoryKeyword, KeywordRuleId } from "./model";
import { findKeywordCategory, findKnownCaptureCategory } from "./rules";

const domicilios = CategoryId.make("11111111-1111-4111-8111-111111111111");
const mercado = CategoryId.make("22222222-2222-4222-8222-222222222222");

it.effect("uses the most specific matching user keyword without caring about case or accents", () =>
  Effect.gen(function* () {
    const category = yield* findKeywordCategory({
      merchant: "RÁPPI Turbo Bogotá",
      rules: [
        {
          id: KeywordRuleId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          keyword: CategoryKeyword.make("rappi"),
          categoryId: domicilios,
        },
        {
          id: KeywordRuleId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
          keyword: CategoryKeyword.make("Rappi Turbo"),
          categoryId: mercado,
        },
      ],
    });

    expect(Option.getOrUndefined(category)).toBe(mercado);
  })
);

it.effect("uses lexical rule identity for equal-length ties and returns None without a match", () =>
  Effect.gen(function* () {
    const earlier = CategoryId.make("33333333-3333-4333-8333-333333333333");
    const category = yield* findKeywordCategory({
      merchant: "ab tienda cd",
      rules: [
        {
          id: KeywordRuleId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
          keyword: CategoryKeyword.make("cd"),
          categoryId: mercado,
        },
        {
          id: KeywordRuleId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          keyword: CategoryKeyword.make("ab"),
          categoryId: earlier,
        },
      ],
    });
    const absent = yield* findKeywordCategory({ merchant: "sin coincidencia", rules: [] });

    expect(Option.getOrUndefined(category)).toBe(earlier);
    expect(Option.isNone(absent)).toBe(true);
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
