import { expect, it } from "@effect/vitest";
import { BudgetCurrencyImmutable, BudgetId, BudgetNotFound } from "~/core/budgets/contract";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { toApiFailure } from "./operations";

it("projects an unavailable Budget without exposing its identity or advertising unauthorized reads", () => {
  const failure = new BudgetNotFound({
    budgetId: BudgetId.make("10000000-0000-4000-8000-000000000001"),
  });
  const denied = toApiFailure({ failure, caller: freePatCaller(["write"]) });
  expect(denied.error.code).toBe("not_found");
  expect(JSON.stringify(denied)).not.toContain(failure.budgetId);
  expect(denied.next).toEqual([]);
  const allowed = toApiFailure({ failure, caller: freePatCaller(["read"]) });
  expect(allowed.next.map((next) => next.tool)).toEqual(["budgets.listBudgets"]);
});

it("explains an immutable Currency failure at the cap field without suggesting conversion", () => {
  const result = toApiFailure({
    failure: new BudgetCurrencyImmutable({ expected: "COP", received: "USD" }),
    caller: freePatCaller(["read", "write"]),
  });
  expect(result.error.code).toBe("validation_failed");
  expect(result.error.fields).toEqual([
    { path: "cap.currency", message: "Expected COP, received USD." },
  ]);
});
