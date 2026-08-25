import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { BudgetStatus } from "~/core/budgets/model";
import { budgetStatusResult } from "./view";

const commonStatus = {
  budget: {
    id: "f1d1a000-0000-4000-8000-0000000000bb",
    categoryId: "10000000-0000-4000-8000-000000000001",
    cap: { amount: "100", currency: "COP" },
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-01T12:00:00Z",
  },
  period: {
    from: "2026-07-01T05:00:00Z",
    to: "2026-08-01T05:00:00Z",
    timeZone: "America/Bogota",
  },
} as const;

it("projects every closed Budget status without its acquisition facts", () => {
  const under = Schema.decodeUnknownSync(BudgetStatus)({
    ...commonStatus,
    type: "under",
    spent: { amount: "25", currency: "COP" },
    remaining: { amount: "75", currency: "COP" },
  });
  const reached = Schema.decodeUnknownSync(BudgetStatus)({
    ...commonStatus,
    type: "reached",
    spent: { amount: "100", currency: "COP" },
  });
  const over = Schema.decodeUnknownSync(BudgetStatus)({
    ...commonStatus,
    type: "over",
    spent: { amount: "125", currency: "COP" },
    overBy: { amount: "25", currency: "COP" },
  });

  const underResult = budgetStatusResult(under);
  const overResult = budgetStatusResult(over);
  expect(underResult.type).toBe("under");
  expect("remaining" in underResult).toBe(true);
  expect(budgetStatusResult(reached)).toEqual({ type: "reached" });
  expect(overResult.type).toBe("over");
  expect("overBy" in overResult).toBe(true);
});
