import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option } from "effect";
import { Currency, Money } from "~/core/_shared/money";
import { categoryIds } from "~/core/categories/taxonomy";
import type { FinancialFacts } from "./model";
import { sameFinancialFacts, scoreRun } from "./scoring";

const facts = (amount: string, occurredAt = "2025-01-15T15:00:00Z"): FinancialFacts => ({
  money: Money.make({
    amount: BigDecimal.fromStringUnsafe(amount),
    currency: Currency.make("COP"),
  }),
  counterparty: Option.some("Comercio Sintético"),
  direction: "outflow",
  occurredAt: DateTime.makeUnsafe(occurredAt),
  categoryId: categoryIds.otros,
});

it("compares exact financial facts without treating BigDecimal scale as meaning", () => {
  expect(sameFinancialFacts([facts("25000.50")], [facts("25000.5")])).toBe(true);
  expect(sameFinancialFacts([facts("25000.51")], [facts("25000.5")])).toBe(false);
});

it("preserves two distinct equal-Money movements in multiset comparisons", () => {
  const expected = [facts("25000.5"), facts("25000.5", "2025-01-16T15:00:00Z")];
  expect(sameFinancialFacts(expected, expected)).toBe(true);
  expect(sameFinancialFacts(expected, expected.slice(0, 1))).toBe(false);
});

it("marks a run incomplete when failed and unobserved checks coexist", () => {
  const scored = scoreRun([
    {
      id: "synthetic",
      repetition: 1,
      track: "quality",
      outcome: "scored",
      checks: [
        { id: "exact-financial-facts", critical: true, status: "failed" },
        { id: "reply-rubric", critical: false, status: "not-observed" },
      ],
    },
  ]);
  expect(scored.conclusion).toBe("incomplete");
  expect(scored.critical).toEqual({ planned: 1, passed: 0, failed: 1, notObserved: 0 });
});

it("keeps incomplete evidence in the planned denominator", () => {
  const scored = scoreRun([
    {
      id: "synthetic",
      repetition: 1,
      track: "quality",
      outcome: "provider-unavailable",
      checks: [{ id: "exact-financial-facts", critical: true, status: "not-observed" }],
    },
  ]);
  expect(scored.conclusion).toBe("incomplete");
  expect(scored.quality).toEqual({ planned: 1, passed: 0, failed: 0, notObserved: 1 });
});
