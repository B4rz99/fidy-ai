import { BigDecimal } from "effect";
import type {
  BudgetStatusQueryParameters,
  BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";

/** Cash flow, cap spending and uncovered outflows share one complete exact snapshot. */
export const monthlySpending = ({
  aggregates,
  query,
  statuses,
}: Readonly<{
  aggregates: ReadonlyArray<EffectiveTransactionAggregate>;
  query: typeof BudgetStatusQueryParameters.Type;
  statuses: BudgetStatusReport["statuses"];
}>): Pick<BudgetStatusReport, "cashFlow" | "unbudgetedExpenses"> => {
  const selected = aggregates.filter(
    (row) =>
      (query.categoryId === undefined || row.categoryId === query.categoryId) &&
      (query.currency === undefined || row.sum.currency === query.currency)
  );
  return {
    cashFlow: { income: total(selected, "inflow"), expenses: total(selected, "outflow") },
    unbudgetedExpenses: selected
      .filter(
        (row) =>
          row.direction === "outflow" &&
          !statuses.some(
            (status) =>
              status.budget.categoryId === row.categoryId &&
              status.budget.cap.currency === row.sum.currency
          )
      )
      .map((row) => ({ categoryId: row.categoryId, spent: row.sum })),
  };
};

const total = (
  rows: ReadonlyArray<
    Readonly<{
      direction: "inflow" | "outflow";
      sum: BudgetStatusReport["cashFlow"]["income"][number];
    }>
  >,
  direction: "inflow" | "outflow"
): BudgetStatusReport["cashFlow"]["income"] => {
  const matching = rows.filter((row) => row.direction === direction);
  return [...new Set(matching.map((row) => row.sum.currency))].sort().map((currency) => ({
    currency,
    amount: BigDecimal.sumAll(
      matching.filter((row) => row.sum.currency === currency).map((row) => row.sum.amount)
    ),
  }));
};
