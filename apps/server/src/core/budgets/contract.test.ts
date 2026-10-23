import { hasExactBudgetProgress } from "./operations";
import { expect, it } from "@effect/vitest";
import { BigDecimal, Result, Schema } from "effect";
import {
  AppliedBudgetMonth,
  Budget,
  BudgetCrossing,
  BudgetGroupName,
  BudgetMonth,
  BudgetMonthLatch,
  BudgetProgress,
  type BudgetProgressFact,
  BudgetStatus,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "./contract";

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

it("rejects crossing snapshots with mixed Currency or spending below the exact latched threshold", () => {
  const crossing = {
    budgetId: budgetInput.id,
    categoryId: budgetInput.categoryId,
    cap: { amount: "100", currency: "COP" },
    spent: { amount: "80", currency: "COP" },
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
    threshold: 80,
    detectedAt: "2026-07-02T23:00:00Z",
    serviceMarket: "CO",
    locale: "es-CO",
  } as const;
  const decode = Schema.decodeResult(BudgetCrossing);
  expect(Result.isSuccess(decode(crossing))).toBe(true);
  expect(Result.isFailure(decode({ ...crossing, spent: { amount: "80", currency: "USD" } }))).toBe(
    true
  );
  expect(
    Result.isFailure(decode({ ...crossing, spent: { amount: "79.99", currency: "COP" } }))
  ).toBe(true);
  expect(Result.isFailure(decode({ ...crossing, threshold: 100 }))).toBe(true);
  expect(Result.isFailure(decode({ ...crossing, cap: { amount: "0", currency: "COP" } }))).toBe(
    true
  );
});

it("accepts a Budget with a positive nested Money cap", () => {
  expect(Result.isSuccess(Schema.decodeResult(Budget)(budgetInput))).toBe(true);
});

it("rejects a zero cap at the nested Money amount field in every write input", () => {
  const create = Schema.decodeResult(CreateBudgetInput)({
    categoryId: budgetInput.categoryId,
    cap: { amount: "0", currency: "COP" },
  });
  const update = Schema.decodeResult(UpdateBudgetInput)({
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
    const decoded = Schema.decodeResult(AppliedBudgetMonth)({
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

it("accepts every reachable monthly threshold and rejects other values", () => {
  const decode = Schema.decodeUnknownResult(BudgetMonthLatch);
  const common = {
    budgetId: budgetInput.id,
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
  };

  for (const highestReached of [0, 80, 100]) {
    expect(Result.isSuccess(decode({ ...common, highestReached }))).toBe(true);
  }
  expect(Result.isFailure(decode({ ...common, highestReached: 81 }))).toBe(true);
});

it("rejects mixed-Currency progress before comparing or subtracting its amounts", () => {
  const decode = Schema.decodeUnknownResult(Schema.toCodecJson(BudgetProgress));
  const cap = { amount: "100", currency: "COP" };
  const sameSpent = { amount: "25", currency: "COP" };
  for (const progress of [
    {
      cap,
      spent: { amount: "25", currency: "USD" },
      status: { type: "under", remaining: { amount: "75", currency: "COP" } },
    },
    {
      cap,
      spent: sameSpent,
      status: { type: "under", remaining: { amount: "75", currency: "EUR" } },
    },
    { cap, spent: { amount: "100", currency: "USD" }, status: { type: "reached" } },
    {
      cap,
      spent: { amount: "125", currency: "COP" },
      status: { type: "over", overBy: { amount: "25", currency: "USD" } },
    },
  ]) {
    expect(Result.isFailure(decode(progress))).toBe(true);
  }
});

it("requires the full selected group and month when changing a Budget Group Currency", () => {
  const decode = Schema.decodeUnknownResult(UpdateBudgetInput);
  const base = { categoryId: budgetInput.categoryId, cap: budgetInput.cap };
  const grouped = {
    ...base,
    groupName: "Casa",
    month: "2026-10",
    groupCurrency: "COP",
    groupCategoryIds: [budgetInput.categoryId],
  };
  expect(Result.isSuccess(decode(base))).toBe(true);
  expect(Result.isSuccess(decode(grouped))).toBe(true);
  for (const key of ["groupName", "month", "groupCategoryIds"] as const) {
    const { [key]: _, ...incomplete } = grouped;
    expect(Result.isFailure(decode(incomplete))).toBe(true);
  }
  expect(
    Result.isFailure(
      decode({ ...grouped, groupCategoryIds: ["10000000-0000-4000-8000-000000000002"] })
    )
  ).toBe(true);
  expect(Result.isFailure(decode({ ...base, groupCategoryIds: [budgetInput.categoryId] }))).toBe(
    true
  );
  expect(
    Result.isSuccess(
      decode({ ...base, groupName: "Casa", groupCategoryIds: [budgetInput.categoryId] })
    )
  ).toBe(true);
});

it("bounds monthly plan labels and requires visible text in a Budget Group name", () => {
  const decodeMonth = Schema.decodeUnknownResult(BudgetMonth);
  for (const value of ["2000-01", "9999-12", "2026-09", "2026-10"]) {
    expect(Result.isSuccess(decodeMonth(value))).toBe(true);
  }
  for (const value of [
    "1999-12",
    "2026-00",
    "2026-13",
    "2026-1",
    "x2026-01",
    "2026-01x",
    "202a-01",
    "2026/01",
  ]) {
    expect(Result.isFailure(decodeMonth(value))).toBe(true);
  }
  const decodeName = Schema.decodeUnknownResult(BudgetGroupName);
  for (const value of ["Casa", "Mi casa", "a".repeat(64)]) {
    expect(Result.isSuccess(decodeName(value))).toBe(true);
  }
  for (const value of ["", " ", "\n\t", "a".repeat(65)]) {
    expect(Result.isFailure(decodeName(value))).toBe(true);
  }
});

it("preserves the exact remaining or overage Money in all valid Budget progress variants", () => {
  const codec = Schema.toCodecJson(BudgetProgress);
  const cap = { amount: "100", currency: "COP" };
  for (const value of [
    {
      cap,
      spent: { amount: "25", currency: "COP" },
      status: { type: "under", remaining: { amount: "75", currency: "COP" } },
    },
    { cap, spent: cap, status: { type: "reached" } },
    {
      cap,
      spent: { amount: "125", currency: "COP" },
      status: { type: "over", overBy: { amount: "25", currency: "COP" } },
    },
  ]) {
    expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(value))).toEqual(value);
  }
});

it("reports missing collection context before a dependent group rename refusal", () => {
  const decoded = Schema.decodeResult(UpdateBudgetInput)({
    categoryId: budgetInput.categoryId,
    cap: budgetInput.cap,
    groupCurrency: "COP",
    groupCategoryIds: [budgetInput.categoryId],
    month: "2026-10",
  });
  expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toContain(
    "Group currency requires a selected collection, name, and month"
  );
});
