import type { BudgetId } from "../../src/core/budgets/contract";

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
