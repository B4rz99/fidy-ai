import { BigDecimal, DateTime, Effect } from "effect";
import { type IanaTimeZone } from "~/core/_shared/context";
import { type Immutable } from "~/core/_shared/immutable";
import { CurrencyMismatch, Money, type ReadonlyMoney } from "~/core/_shared/money";
import { type AppliedBudgetMonth, type Budget, type BudgetStatus } from "./model";

/** Derives one calendar month's half-open UTC bounds from an explicit instant and IANA zone. */
export const deriveCurrentBudgetMonth = ({
  now,
  timeZone,
}: Readonly<{
  now: DateTime.Utc;
  timeZone: IanaTimeZone;
}>): AppliedBudgetMonth => {
  const zonedNow = DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(timeZone));
  const zonedFrom = DateTime.startOf(zonedNow, "month");
  return {
    from: DateTime.toUtc(zonedFrom),
    to: DateTime.toUtc(DateTime.add(zonedFrom, { months: 1 })),
    timeZone,
  };
};

type BudgetStatusInput = Immutable<{
  budget: Budget;
  spent: ReadonlyMoney;
  period: AppliedBudgetMonth;
}>;

/** Compares exact same-Currency spending with a cap and returns its closed monthly status. */
export const calculateBudgetStatus: (
  input: BudgetStatusInput
) => Effect.Effect<BudgetStatus, CurrencyMismatch> = Effect.fn("calculateBudgetStatus")(function* (
  input: BudgetStatusInput
) {
  const { budget, period, spent } = input;
  if (budget.cap.currency !== spent.currency) {
    return yield* new CurrencyMismatch({
      left: budget.cap.currency,
      right: spent.currency,
    });
  }

  const common = { budget, spent: Money.make(spent), period };
  const comparison = BigDecimal.Order(spent.amount, budget.cap.amount);
  if (comparison < 0) {
    return {
      ...common,
      type: "under" as const,
      remaining: Money.make({
        amount: BigDecimal.subtract(budget.cap.amount, spent.amount),
        currency: budget.cap.currency,
      }),
    } satisfies BudgetStatus;
  }
  if (comparison === 0) {
    return { ...common, type: "reached" as const } satisfies BudgetStatus;
  }
  return {
    ...common,
    type: "over" as const,
    overBy: Money.make({
      amount: BigDecimal.subtract(spent.amount, budget.cap.amount),
      currency: budget.cap.currency,
    }),
  } satisfies BudgetStatus;
});
