import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  AppliedBudgetMonth,
  Budget,
  BudgetMonthLatch,
  BudgetStatus,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "./model";

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

it("rejects bounds that are not exactly one calendar month in the applied zone", () => {
  const decoded = Schema.decodeUnknownResult(AppliedBudgetMonth)({
    from: "2026-07-02T05:00:00Z",
    to: "2026-08-02T05:00:00Z",
    timeZone: "America/Bogota",
  });

  expect(Result.isFailure(decoded)).toBe(true);
});

it("rejects a Budget status whose Money values do not share the cap Currency", () => {
  const decoded = Schema.decodeUnknownResult(BudgetStatus)({
    type: "under",
    budget: budgetInput,
    spent: { amount: "10", currency: "USD" },
    remaining: { amount: "999990", currency: "COP" },
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
  });

  const contradictory = Schema.decodeUnknownResult(BudgetStatus)({
    type: "under",
    budget: budgetInput,
    spent: { amount: "10", currency: "COP" },
    remaining: { amount: "10", currency: "COP" },
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
  });

  expect(Result.isFailure(decoded)).toBe(true);
  expect(Result.isFailure(contradictory)).toBe(true);
});

it("models monthly threshold marks as closed boolean state", () => {
  const decoded = Schema.decodeUnknownResult(BudgetMonthLatch)({
    budgetId: budgetInput.id,
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
    reached80: false,
    reached100: false,
  });

  const impossible = Schema.decodeUnknownResult(BudgetMonthLatch)({
    budgetId: budgetInput.id,
    period: {
      from: "2026-07-01T05:00:00Z",
      to: "2026-08-01T05:00:00Z",
      timeZone: "America/Bogota",
    },
    reached80: false,
    reached100: true,
  });

  expect(Result.isSuccess(decoded)).toBe(true);
  expect(Result.isFailure(impossible)).toBe(true);
});
