import { BigDecimal, DateTime, Effect } from "effect";
import { type IanaTimeZone } from "~/core/_shared/context";
import { CurrencyMismatch, Money, type ReadonlyMoney } from "~/core/_shared/money";
import {
  type AppliedBudgetMonth,
  type Budget,
  type BudgetMonthLatch,
  type BudgetStatus,
} from "./model";

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

type BudgetMovement = Readonly<{
  money: ReadonlyMoney;
  categoryId: Budget["categoryId"];
  direction: "inflow" | "outflow";
  occurredAt: DateTime.Utc;
}>;

/**
 * Sum only outflows of the Budget's Category and Currency within the applied half-open month.
 * The caller supplies movements for one User; this pure decision never establishes ownership.
 * No numeric conversion or cross-Currency arithmetic is performed.
 */
export const sumBudgetContributions = ({
  budget,
  period,
  movements,
}: Readonly<{
  budget: Readonly<{ categoryId: Budget["categoryId"]; cap: ReadonlyMoney }>;
  period: AppliedBudgetMonth;
  movements: ReadonlyArray<BudgetMovement>;
}>): Money => {
  let amount = BigDecimal.make(0n, 0);
  for (const movement of movements) {
    if (
      movement.direction === "outflow" &&
      movement.categoryId === budget.categoryId &&
      movement.money.currency === budget.cap.currency &&
      movement.occurredAt.epochMilliseconds >= period.from.epochMilliseconds &&
      movement.occurredAt.epochMilliseconds < period.to.epochMilliseconds
    ) {
      amount = BigDecimal.sum(amount, movement.money.amount);
    }
  }
  return Money.make({ amount, currency: budget.cap.currency });
};

const threshold80 = 80;
const threshold100 = 100;

const markBudgetLatch = (
  latch: BudgetMonthLatch,
  reached80: boolean,
  reached100: boolean
): BudgetMonthLatch => {
  const common = { budgetId: latch.budgetId, period: latch.period };
  if (reached100) return { ...common, reached80: true, reached100: true };
  if (reached80) return { ...common, reached80: true, reached100: false };
  return { ...common, reached80: false, reached100: false };
};

const newlyReachedThresholds = (
  latch: BudgetMonthLatch,
  reached80: boolean,
  reached100: boolean
): ReadonlyArray<typeof threshold80 | typeof threshold100> => {
  const thresholds: Array<typeof threshold80 | typeof threshold100> = [];
  if (!latch.reached80 && reached80) thresholds.push(threshold80);
  if (!latch.reached100 && reached100) thresholds.push(threshold100);
  return thresholds;
};

/**
 * Advance the two monotone threshold marks for one Budget and applied month. The caller must
 * supply the latch belonging to this Budget and period. The adapter must commit durable,
 * versioned evaluation intent with the Transaction change, drain it before any later correction,
 * and persist marks with unique per-threshold occurrences; a correction never reopens a mark.
 * Spending in another Currency fails without comparison or conversion.
 */
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
    const reached80 = latch.reached80 || BigDecimal.Order(spent.amount, eighty) >= 0;
    const reached100 = latch.reached100 || BigDecimal.Order(spent.amount, budget.cap.amount) >= 0;
    return {
      latch: markBudgetLatch(latch, reached80, reached100),
      newlyReached: newlyReachedThresholds(latch, reached80, reached100),
    };
  });

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
