import { BigDecimal } from "effect";
import type { Currency } from "../../../src/core/_shared/money";
import type {
  BudgetStatusQueryParameters,
  BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";

/** Request-local exact totals; no cross-Currency addition or repeated scans of the snapshot. */
export const monthlySpending = ({
  aggregates,
  query,
  statuses,
}: Readonly<{
  aggregates: ReadonlyArray<EffectiveTransactionAggregate>;
  query: typeof BudgetStatusQueryParameters.Type;
  statuses: BudgetStatusReport["statuses"];
}>): Pick<BudgetStatusReport, "cashFlow" | "unbudgetedExpenses"> => {
  const covered = new Set(
    statuses.map((status) => `${status.budget.cap.currency}:${status.budget.categoryId}`)
  );
  const totals = {
    inflow: new Map<Currency, BigDecimal.BigDecimal>(),
    outflow: new Map<Currency, BigDecimal.BigDecimal>(),
  };
  const unbudgetedExpenses: Array<BudgetStatusReport["unbudgetedExpenses"][number]> = [];
  for (const row of aggregates) {
    if (!matchesQuery(row, query)) {
      continue;
    }
    const byCurrency = totals[row.direction];
    byCurrency.set(
      row.sum.currency,
      BigDecimal.sum(byCurrency.get(row.sum.currency) ?? BigDecimal.make(0n, 0), row.sum.amount)
    );
    if (row.direction === "outflow" && !covered.has(`${row.sum.currency}:${row.categoryId}`)) {
      unbudgetedExpenses.push({ categoryId: row.categoryId, spent: row.sum });
    }
  }
  return {
    cashFlow: { income: orderedTotals(totals.inflow), expenses: orderedTotals(totals.outflow) },
    unbudgetedExpenses,
  };
};

const orderedTotals = (
  totals: ReadonlyMap<Currency, BigDecimal.BigDecimal>
): BudgetStatusReport["cashFlow"]["income"] =>
  [...totals]
    .sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    })
    .map(([currency, amount]) => ({ currency, amount }));

const matchesQuery = (
  row: EffectiveTransactionAggregate,
  query: typeof BudgetStatusQueryParameters.Type
): boolean =>
  (query.categoryId === undefined || row.categoryId === query.categoryId) &&
  (query.currency === undefined || row.sum.currency === query.currency);
