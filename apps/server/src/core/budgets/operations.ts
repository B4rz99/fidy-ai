import { BigDecimal, DateTime, Effect, Schema } from "effect";
import { type IanaTimeZone } from "~/core/_shared/context";
import { CurrencyMismatch, Money, type ReadonlyMoney } from "~/core/_shared/money";
import {
  type AppliedBudgetMonth,
  type Budget,
  type BudgetMonthLatch,
  BudgetProgress,
  type BudgetProgressFact,
  type BudgetStatus,
} from "./contract";

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

type BudgetStatusInput = Readonly<{
  budget: Readonly<{
    id: Budget["id"];
    categoryId: Budget["categoryId"];
    cap: ReadonlyMoney;
    createdAt: Budget["createdAt"];
    updatedAt: Budget["updatedAt"];
  }>;
  spent: ReadonlyMoney;
  period: Readonly<{
    from: AppliedBudgetMonth["from"];
    to: AppliedBudgetMonth["to"];
    timeZone: AppliedBudgetMonth["timeZone"];
  }>;
}>;

const threshold80 = 80;

const threshold100 = 100;

const thresholds = [threshold80, threshold100] as const;

export const advanceBudgetLatch = ({
  budget,
  spent,
  latch,
}: Readonly<{
  budget: Readonly<{ id: Budget["id"]; cap: ReadonlyMoney }>;
  spent: ReadonlyMoney;
  latch: BudgetMonthLatch;
}>): Effect.Effect<
  Readonly<{
    latch: BudgetMonthLatch;
    newlyReached: ReadonlyArray<typeof threshold80 | typeof threshold100>;
  }>,
  CurrencyMismatch
> =>
  Effect.gen(function* () {
    if (spent.currency !== budget.cap.currency) {
      return yield* new CurrencyMismatch({ left: budget.cap.currency, right: spent.currency });
    }

    const eighty = BigDecimal.multiply(budget.cap.amount, BigDecimal.make(8n, 1));
    let measured: 0 | typeof threshold80 | typeof threshold100 = 0;

    if (BigDecimal.Order(spent.amount, eighty) >= 0) measured = threshold80;

    if (BigDecimal.Order(spent.amount, budget.cap.amount) >= 0) measured = threshold100;
    const highestReached = measured > latch.highestReached ? measured : latch.highestReached;

    return {
      latch: { ...latch, highestReached },
      newlyReached: thresholds.filter(
        (threshold) => threshold > latch.highestReached && threshold <= highestReached
      ),
    };
  });

export const calculateBudgetStatus: (
  input: BudgetStatusInput
) => Effect.Effect<BudgetStatus, CurrencyMismatch> = Effect.fnUntraced(function* (
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

export const hasExactBudgetProgress = (progress: BudgetProgressFact): boolean =>
  Schema.is(BudgetProgress)(progress);
