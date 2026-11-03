import { BigDecimal, Effect } from "effect";
import type { CurrencyMismatch } from "../../../src/core/_shared/money";
import { Money } from "../../../src/core/_shared/money";
import type {
  AppliedBudgetMonth,
  Budget,
  BudgetStatusQueryParameters,
  BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import { calculateBudgetStatus } from "../../../src/core/budgets/operations";
import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";
import { monthlySpending } from "./monthly-cash-flow";

/** Index one request's exact outflows once; no result or working index survives the request. */
export const assembleBudgetReport = ({
  budgets,
  aggregates,
  period,
  query,
  initialized,
}: Readonly<{
  budgets: ReadonlyArray<Budget>;
  aggregates: ReadonlyArray<EffectiveTransactionAggregate>;
  period: AppliedBudgetMonth;
  query: typeof BudgetStatusQueryParameters.Type;
  initialized: boolean;
}>): Effect.Effect<BudgetStatusReport, CurrencyMismatch> =>
  Effect.gen(function* () {
    const outflows = new Map<string, Money>();
    for (const row of aggregates) {
      if (row.direction === "outflow") {
        outflows.set(`${row.sum.currency}:${row.categoryId}`, row.sum);
      }
    }
    const statuses = yield* Effect.forEach(
      budgets.filter(
        (budget) =>
          (query.categoryId === undefined || budget.categoryId === query.categoryId) &&
          (query.currency === undefined || budget.cap.currency === query.currency)
      ),
      (budget) =>
        calculateBudgetStatus({
          budget,
          period,
          spent:
            outflows.get(`${budget.cap.currency}:${budget.categoryId}`) ??
            Money.make({ amount: BigDecimal.make(0n, 0), currency: budget.cap.currency }),
        })
    );
    return { period, statuses, initialized, ...monthlySpending({ aggregates, query, statuses }) };
  });
