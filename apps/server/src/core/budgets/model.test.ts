import { expect, it } from "@effect/vitest";
import { BigDecimal, Result, Schema } from "effect";
import {
  AppliedBudgetMonth,
  Budget,
  BudgetMonthLatch,
  type BudgetProgressFact,
  BudgetStatus,
  CreateBudgetInput,
  UpdateBudgetInput,
  hasExactBudgetProgress,
} from "./model";

const money = (amount: string): BudgetProgressFact["cap"] => ({
  amount: BigDecimal.fromStringUnsafe(amount),
  currency: "COP" as const,
});

const budgetInput = {
  id: "f1d1a000-0000-4000-8000-0000000000bb",
  categoryId: "10000000-0000-4000-8000-000000000001",
  cap: { amount: "1000000", currency: "COP" },
  createdAt: "2026-07-01T12:00:00Z",
  updatedAt: "2026-07-01T12:00:00Z",
} as const;

it("accepts a Budget with a positive nested Money cap", () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(Budget)(budgetInput))).toBe(true);
});

it("rejects a zero cap at the nested Money amount field in every write input", () => {
  const create = Schema.decodeUnknownResult(CreateBudgetInput)({
    categoryId: budgetInput.categoryId,
    cap: { amount: "0", currency: "COP" },
  });
  const update = Schema.decodeUnknownResult(UpdateBudgetInput)({
    categoryId: budgetInput.categoryId,
    cap: { amount: "0", currency: "COP" },
  });

  expect(Result.isFailure(create) ? String(create.failure) : "").toContain('["cap"]["amount"]');
  expect(Result.isFailure(update) ? String(update.failure) : "").toContain('["cap"]["amount"]');
});

it("rejects either incorrect calendar bound and reports the end path", () => {
  for (const bounds of [
    {
      from: "2026-07-02T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
    },
    {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-02T05:00:00Z",
    },
  ]) {
    const decoded = Schema.decodeUnknownResult(AppliedBudgetMonth)({
      ...bounds,
      timeZone: "America/Bogota",
    });

    expect(Result.isFailure(decoded)).toBe(true);
    expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toContain('["to"]');
  }
});

it("decodes exact Budget statuses and reports each Currency mismatch at its field", () => {
  const decode = Schema.decodeUnknownResult(BudgetStatus);
  const period = {
    from: "2026-07-01T05:00:00Z",
    to: "2026-08-01T05:00:00Z",
    timeZone: "America/Bogota",
  } as const;
  const under = {
    type: "under" as const,
    budget: budgetInput,
    spent: { amount: "10", currency: "COP" },
    remaining: { amount: "999990", currency: "COP" },
    period,
  };
  const reached = {
    type: "reached" as const,
    budget: budgetInput,
    spent: { amount: "1000000", currency: "COP" },
    period,
  };
  const over = {
    type: "over" as const,
    budget: budgetInput,
    spent: { amount: "1000001", currency: "COP" },
    overBy: { amount: "1", currency: "COP" },
    period,
  };

  for (const status of [under, reached, over]) {
    expect(Result.isSuccess(decode(status))).toBe(true);
  }

  const spentCurrencyMismatch = decode({
    ...under,
    spent: { amount: "10", currency: "USD" },
  });
  const remainingCurrencyMismatch = decode({
    ...under,
    remaining: { amount: "999990", currency: "USD" },
  });
  const overageCurrencyMismatch = decode({
    ...over,
    overBy: { amount: "1", currency: "USD" },
  });
  const contradictory = decode({
    ...under,
    remaining: { amount: "10", currency: "COP" },
  });

  expect(Result.isFailure(spentCurrencyMismatch)).toBe(true);
  expect(
    Result.isFailure(spentCurrencyMismatch) ? String(spentCurrencyMismatch.failure) : ""
  ).toContain('["spent"]["currency"]');
  expect(Result.isFailure(remainingCurrencyMismatch)).toBe(true);
  expect(
    Result.isFailure(remainingCurrencyMismatch) ? String(remainingCurrencyMismatch.failure) : ""
  ).toContain('["remaining"]["currency"]');
  expect(Result.isFailure(overageCurrencyMismatch)).toBe(true);
  expect(
    Result.isFailure(overageCurrencyMismatch) ? String(overageCurrencyMismatch.failure) : ""
  ).toContain('["overBy"]["currency"]');
  expect(Result.isFailure(contradictory)).toBe(true);
  expect(Result.isFailure(contradictory) ? String(contradictory.failure) : "").toContain(
    '["type"]'
  );
});

it("recognizes every exact Budget progress state and rejects contradictions", () => {
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("25"),
      status: { type: "under", remaining: money("75") },
    })
  ).toBe(true);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("100"),
      status: { type: "reached" },
    })
  ).toBe(true);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("125"),
      status: { type: "over", overBy: money("25") },
    })
  ).toBe(true);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("100"),
      status: { type: "under", remaining: money("0") },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("100"),
      status: { type: "over", overBy: money("0") },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("0"),
      spent: money("0"),
      status: { type: "reached" },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("25"),
      status: { type: "under", remaining: money("74") },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("99"),
      status: { type: "reached" },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("125"),
      status: { type: "over", overBy: money("24") },
    })
  ).toBe(false);
});

it("rejects boxed status discriminants even when their text matches a Budget variant", () => {
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("25"),
      status: { type: Object.assign("under", {}), remaining: money("75") },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("100"),
      status: { type: Object.assign("reached", {}) },
    })
  ).toBe(false);
  expect(
    hasExactBudgetProgress({
      cap: money("100"),
      spent: money("125"),
      status: { type: Object.assign("over", {}), overBy: money("25") },
    })
  ).toBe(false);
});

it("accepts every reachable monthly threshold state and excludes 100% without 80%", () => {
  const decode = Schema.decodeUnknownResult(BudgetMonthLatch);
  const common = {
    budgetId: budgetInput.id,
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
  };

  for (const marks of [
    { reached80: false, reached100: false },
    { reached80: true, reached100: false },
    { reached80: true, reached100: true },
  ]) {
    expect(Result.isSuccess(decode({ ...common, ...marks }))).toBe(true);
  }
  expect(Result.isFailure(decode({ ...common, reached80: false, reached100: true }))).toBe(true);
});
