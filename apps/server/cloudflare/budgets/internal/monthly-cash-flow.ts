import { BigDecimal, DateTime, Effect, Option } from "effect";
import type {
  BudgetStatusQueryParameters,
  BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import { findDashboardAggregate } from "../../transactions/operations";

/** All effective monthly transactions, including categories without expense caps. */
export const readMonthlyCashFlow = ({
  db,
  userId,
  period,
  query,
}: Readonly<{
  db: D1Database;
  userId: string;
  period: BudgetStatusReport["period"];
  query: typeof BudgetStatusQueryParameters.Type;
}>): Effect.Effect<Option.Option<BudgetStatusReport["cashFlow"]>> =>
  Effect.gen(function* () {
    const aggregates = yield* findDashboardAggregate({
      db,
      userId,
      from: DateTime.toEpochMillis(period.from),
      toExclusive: DateTime.toEpochMillis(period.to),
    });
    return Option.map(aggregates, (rows) => {
      const selected = rows.filter(
        (row) =>
          (query.categoryId === undefined || row.categoryId === query.categoryId) &&
          (query.currency === undefined || row.sum.currency === query.currency)
      );
      return { income: total(selected, "inflow"), expenses: total(selected, "outflow") };
    });
  });

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
