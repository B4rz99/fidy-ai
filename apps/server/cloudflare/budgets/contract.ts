import { Data } from "effect";
import type { AppliedBudgetMonth, BudgetId } from "../../src/core/budgets/contract";
import type { UserId } from "../../src/core/identity/contract";

/** Explicit owned month whose historical crossing facts a coordinated peer may observe. */
export type BudgetCrossingRead = Readonly<{
  db: D1Database;
  userId: UserId;
  budgetId: BudgetId;
  period: AppliedBudgetMonth;
}>;

/** Crossing facts are malformed, unavailable or predate historical snapshot retention; current facts cannot substitute for them. */
export class BudgetCrossingUnavailable extends Data.TaggedError("BudgetCrossingUnavailable") {}

/** The Budget whose guarded write the canonical unit commits or whose deletion it proves. */
export type BudgetOutcome = Readonly<{
  _tag: "Budget";
  operation: "budgets.createBudget" | "budgets.updateBudget" | "budgets.deleteBudget";
  budgetId: BudgetId;
}>;

/** The canonical reads implemented by the Budget owner for every authorized caller surface. */
export type BudgetQueryOperation =
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus";
