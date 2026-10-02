import { deepStrictEqual } from "node:assert";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Result, Schema } from "effect";
import { CategoryId } from "./reference";
import {
  CategoryKeyword,
  KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleId,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
} from "./contract";
import {
  categorizeCapture,
  normalizeCategoryKeyword,
  validateKeywordRuleChange,
} from "./operations";

const domicilios = CategoryId.make("10000000-0000-4000-8000-000000000002");
const mercado = CategoryId.make("10000000-0000-4000-8000-000000000003");
const first = KeywordRuleId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const second = KeywordRuleId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const rule = (
  id: KeywordRuleId,
  keyword: string,
  categoryId: CategoryId = domicilios
): KeywordRule =>
  Schema.decodeSync(KeywordRule)({
    id,
    keyword,
    categoryId,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

it("normalizes accents without silently trimming surrounding keyword content", () => {
  expect(normalizeCategoryKeyword("  RÁPPI Ñ  ")).toBe("  rappi n  ");
  expect(Result.isFailure(Schema.decodeResult(CategoryKeyword)("́"))).toBe(true);
});

it.effect(
  "prefers explicit Categories before specific, accent-insensitive keyword instructions",
  () =>
    Effect.gen(function* () {
      const rules = [rule(first, "rappi"), rule(second, "Rappi Turbo", mercado)];
      const input = {
        caller: Option.none<CategoryId>(),
        counterparty: Option.some("RÁPPI Turbo Bogotá"),
        direction: "outflow" as const,
        rules,
      };
      expect(yield* categorizeCapture(input)).toBe(mercado);
      expect(yield* categorizeCapture({ ...input, rules: rules.toReversed() })).toBe(mercado);
      expect(yield* categorizeCapture({ ...input, caller: Option.some(domicilios) })).toBe(
        domicilios
      );
    })
);

it.effect(
  "breaks equal keyword matches by stable rule identity and preserves direction fallbacks",
  () =>
    Effect.gen(function* () {
      const input = {
        caller: Option.none<CategoryId>(),
        counterparty: Option.some("ab tienda cd"),
        direction: "outflow" as const,
        rules: [rule(second, "cd", mercado), rule(first, "ab")],
      };
      expect(yield* categorizeCapture(input)).toBe(domicilios);
      expect(
        yield* categorizeCapture({ ...input, counterparty: Option.some("sin coincidencia") })
      ).toBe("10000000-0000-4000-8000-000000000016");
      expect(
        yield* categorizeCapture({ ...input, counterparty: Option.none(), direction: "inflow" })
      ).toBe("10000000-0000-4000-8000-000000000015");
    })
);

it.effect("rejects equivalent keywords while excluding exactly the updated rule", () =>
  Effect.gen(function* () {
    const rules = [rule(first, "Éxito"), rule(second, "Rappi")];
    const keyword = CategoryKeyword.make("exito");
    deepStrictEqual(
      yield* Effect.exit(
        validateKeywordRuleChange({
          rules,
          change: { operation: "categories.createKeywordRule", ruleId: second, keyword },
        })
      ),
      Exit.succeed(Option.some(new KeywordRuleAlreadyExists({ keyword })))
    );
    expect(
      yield* validateKeywordRuleChange({
        rules,
        change: { operation: "categories.updateKeywordRule", ruleId: first, keyword },
      })
    ).toEqual(Option.none());
    deepStrictEqual(
      yield* Effect.exit(
        validateKeywordRuleChange({
          rules,
          change: { operation: "categories.updateKeywordRule", ruleId: second, keyword },
        })
      ),
      Exit.succeed(Option.some(new KeywordRuleAlreadyExists({ keyword })))
    );
    deepStrictEqual(
      yield* Effect.exit(
        validateKeywordRuleChange({
          rules: [],
          change: { operation: "categories.deleteKeywordRule", ruleId: first },
        })
      ),
      Exit.succeed(Option.some(new KeywordRuleNotFound({ keywordRuleId: first })))
    );
  })
);

it.effect("allows the hundredth keyword instruction and refuses the hundred-and-first", () =>
  Effect.gen(function* () {
    const rules = Array.from({ length: 100 }, (_, index) =>
      rule(
        KeywordRuleId.make(`30000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        `rule-${index}`
      )
    );
    const change = {
      operation: "categories.createKeywordRule" as const,
      ruleId: second,
      keyword: CategoryKeyword.make("new"),
    };
    expect(yield* validateKeywordRuleChange({ rules: rules.slice(0, -1), change })).toEqual(
      Option.none()
    );
    deepStrictEqual(
      yield* Effect.exit(validateKeywordRuleChange({ rules, change })),
      Exit.succeed(Option.some(new KeywordRuleLimitReached({ maximum: 100 })))
    );
  })
);
