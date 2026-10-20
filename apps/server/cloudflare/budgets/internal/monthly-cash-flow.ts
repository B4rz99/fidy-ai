import { BigDecimal } from "effect";
import type {
  BudgetStatusQueryParameters,
  BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";

/** Cash flow and cap spending use the same complete exact financial snapshot. */
export const monthlyCashFlow = ({
  aggregates,
  query,
}: Readonly<{
  aggregates: ReadonlyArray<EffectiveTransactionAggregate>;
  query: typeof BudgetStatusQueryParameters.Type;
}>): BudgetStatusReport["cashFlow"] => {
  const selected = aggregates.filter(
    (row) =>
      (query.categoryId === undefined || row.categoryId === query.categoryId) &&
      (query.currency === undefined || row.sum.currency === query.currency)
  );
  return { income: total(selected, "inflow"), expenses: total(selected, "outflow") };
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
