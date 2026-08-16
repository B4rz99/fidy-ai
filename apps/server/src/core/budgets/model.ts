import { BigDecimal, DateTime, Schema, Struct } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { type Immutable } from "~/core/_shared/immutable";
import { Money } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { CategoryId } from "~/core/categories/reference";
import { BudgetId } from "./reference";

export { BudgetId } from "./reference";

const zero = BigDecimal.make(0n, 0);
const positiveBudgetCap = Schema.makeFilter<{
  readonly cap: { readonly amount: Readonly<BigDecimal.BigDecimal> };
}>((budget) =>
  BigDecimal.Order(budget.cap.amount, zero) === 1
    ? undefined
    : {
        path: ["cap", "amount"],
        issue: "Budget cap must be greater than zero",
      }
);

/** One User-owned monthly cap for one Category in the Currency carried by cap. */
export const Budget = Schema.Struct({
  id: BudgetId,
  categoryId: CategoryId,
  cap: Money,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .check(positiveBudgetCap)
  .annotate({ identifier: "Budget" });
export type Budget = typeof Budget.Type;

/** Caller-owned facts for creating a Budget; identity and ownership come from the shell. */
export const CreateBudgetInput = Budget.mapFields(Struct.pick(["categoryId", "cap"]))
  .check(positiveBudgetCap)
  .annotate({ identifier: "CreateBudgetInput" });
export type CreateBudgetInput = typeof CreateBudgetInput.Type;

/** Complete editable Budget facts; the shell rejects a change to cap Currency. */
export const UpdateBudgetInput = Budget.mapFields(Struct.pick(["categoryId", "cap"]))
  .check(positiveBudgetCap)
  .annotate({ identifier: "UpdateBudgetInput" });
export type UpdateBudgetInput = typeof UpdateBudgetInput.Type;

const calendarMonth = Schema.makeFilter<{
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly timeZone: IanaTimeZone;
}>(({ from, timeZone, to }) => {
  const zonedFrom = DateTime.setZone(from, DateTime.zoneMakeNamedUnsafe(timeZone));
  const monthStart = DateTime.startOf(zonedFrom, "month");
  const expectedFrom = DateTime.toUtc(monthStart);
  const expectedTo = DateTime.toUtc(DateTime.add(monthStart, { months: 1 }));
  return from.epochMilliseconds === expectedFrom.epochMilliseconds &&
    to.epochMilliseconds === expectedTo.epochMilliseconds
    ? undefined
    : {
        path: ["to"],
        issue: "Bounds must be one calendar month in the applied time zone",
      };
});

/** Exact half-open UTC bounds of one calendar month in an explicitly applied zone. */
export const AppliedBudgetMonth = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  timeZone: IanaTimeZone,
})
  .check(calendarMonth)
  .annotate({ identifier: "AppliedBudgetMonth" });
export type AppliedBudgetMonth = typeof AppliedBudgetMonth.Type;

const BudgetStatusCommon = {
  budget: Budget,
  spent: Money,
  period: AppliedBudgetMonth,
} as const;

const UnderBudget = Schema.Struct({
  ...BudgetStatusCommon,
  type: Schema.Literal("under"),
  remaining: Money,
});
const ReachedBudget = Schema.Struct({
  ...BudgetStatusCommon,
  type: Schema.Literal("reached"),
});
const OverBudget = Schema.Struct({
  ...BudgetStatusCommon,
  type: Schema.Literal("over"),
  overBy: Money,
});

type StatusCurrencyView = Immutable<
  typeof UnderBudget.Type | typeof ReachedBudget.Type | typeof OverBudget.Type
>;

const sameStatusCurrency = Schema.makeFilter<StatusCurrencyView>((status) => {
  const currency = status.budget.cap.currency;
  if (status.spent.currency !== currency) {
    return {
      path: ["spent", "currency"],
      issue: "Spent Currency must match the Budget cap",
    };
  }
  if (status.type === "under" && status.remaining.currency !== currency) {
    return {
      path: ["remaining", "currency"],
      issue: "Remaining Currency must match the Budget cap",
    };
  }
  if (status.type === "over" && status.overBy.currency !== currency) {
    return {
      path: ["overBy", "currency"],
      issue: "Overage Currency must match the Budget cap",
    };
  }
  return undefined;
});

const hasExactStatusAmounts = (status: StatusCurrencyView): boolean => {
  const comparison = BigDecimal.Order(status.spent.amount, status.budget.cap.amount);
  if (status.type === "under") {
    return (
      comparison < 0 &&
      BigDecimal.equals(
        status.remaining.amount,
        BigDecimal.subtract(status.budget.cap.amount, status.spent.amount)
      )
    );
  }
  if (status.type === "reached") return comparison === 0;
  return (
    comparison > 0 &&
    BigDecimal.equals(
      status.overBy.amount,
      BigDecimal.subtract(status.spent.amount, status.budget.cap.amount)
    )
  );
};

const exactStatusAmounts = Schema.makeFilter<StatusCurrencyView>((status) =>
  hasExactStatusAmounts(status)
    ? undefined
    : {
        path: ["type"],
        issue: "Status must exactly describe cap and spending",
      }
);

/** Exact current-month state of one Budget; decoding rejects mixed-Currency values. */
export const BudgetStatus = Schema.Union([UnderBudget, ReachedBudget, OverBudget])
  .check(sameStatusCurrency, exactStatusAmounts)
  .annotate({ identifier: "BudgetStatus" });
export type BudgetStatus = typeof BudgetStatus.Type;

/** Applied calendar period plus deterministic per-Budget statuses, including when none match. */
export const BudgetStatusReport = Schema.Struct({
  period: AppliedBudgetMonth,
  statuses: Schema.Array(BudgetStatus),
}).annotate({ identifier: "BudgetStatusReport" });
export type BudgetStatusReport = typeof BudgetStatusReport.Type;

/** Values from which optional status lookup filters are projected. */
export const BudgetStatusQueryValues = Schema.Struct({
  categoryId: CategoryId,
  currency: Money.fields.currency,
  timeZone: IanaTimeZone,
});

/** Optional status filters after canonical query decoding. */
export const BudgetStatusQuery = Schema.Struct({
  categoryId: Schema.Option(BudgetStatusQueryValues.fields.categoryId),
  currency: Schema.Option(BudgetStatusQueryValues.fields.currency),
  timeZone: BudgetStatusQueryValues.fields.timeZone,
}).annotate({ identifier: "BudgetStatusQuery" });
export type BudgetStatusQuery = typeof BudgetStatusQuery.Type;

const BudgetMonthLatchCommon = {
  budgetId: BudgetId,
  period: AppliedBudgetMonth,
} as const;

/** Monthly boolean marks as a closed union excluding 100%-without-80%. */
export const BudgetMonthLatch = Schema.Union([
  Schema.Struct({
    ...BudgetMonthLatchCommon,
    reached80: Schema.Literal(false),
    reached100: Schema.Literal(false),
  }),
  Schema.Struct({
    ...BudgetMonthLatchCommon,
    reached80: Schema.Literal(true),
    reached100: Schema.Literal(false),
  }),
  Schema.Struct({
    ...BudgetMonthLatchCommon,
    reached80: Schema.Literal(true),
    reached100: Schema.Literal(true),
  }),
]).annotate({ identifier: "BudgetMonthLatch" });
export type BudgetMonthLatch = typeof BudgetMonthLatch.Type;
