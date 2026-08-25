import { BigDecimal, DateTime } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type { Immutable } from "~/core/_shared/immutable";
import {
  type Currency,
  Money,
  type MoneyGroups,
  type ReadonlyMoney,
  currencyMetadata,
} from "~/core/_shared/money";
import type { AppliedDashboardPeriod, DashboardPeriod } from "./model";

const rollingWeekPreviousDays = 6;
const rollingMonthPreviousDays = 29;
const zero = BigDecimal.make(0n, 0);

type PeriodInput = Readonly<{
  now: DateTime.Utc;
  period: DashboardPeriod;
  timeZone: IanaTimeZone;
}>;

const toAppliedPeriod = (
  input: Readonly<{
    from: Immutable<DateTime.Zoned>;
    toExclusive: Immutable<DateTime.Zoned>;
    requested: DashboardPeriod;
    timeZone: IanaTimeZone;
  }>
): AppliedDashboardPeriod => ({
  requested: input.requested,
  from: DateTime.toUtc(input.from),
  toExclusive: DateTime.toUtc(input.toExclusive),
  timeZone: input.timeZone,
});

/** Resolves a relative period against local calendar boundaries in the explicitly supplied zone. */
export const resolveDashboardPeriod = ({
  now,
  period,
  timeZone,
}: PeriodInput): AppliedDashboardPeriod => {
  const zonedNow = DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(timeZone));
  const dayStart = DateTime.startOf(zonedNow, "day");
  const weekStart = DateTime.startOf(zonedNow, "week", { weekStartsOn: 1 });
  const monthStart = DateTime.startOf(zonedNow, "month");

  switch (period) {
    case "this-week":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: weekStart,
        toExclusive: DateTime.add(weekStart, { weeks: 1 }),
      });
    case "this-month":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: monthStart,
        toExclusive: DateTime.add(monthStart, { months: 1 }),
      });
    case "last-week":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: DateTime.subtract(weekStart, { weeks: 1 }),
        toExclusive: weekStart,
      });
    case "last-month":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: DateTime.subtract(monthStart, { months: 1 }),
        toExclusive: monthStart,
      });
    case "last-7-days":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: DateTime.subtract(dayStart, { days: rollingWeekPreviousDays }),
        toExclusive: DateTime.add(dayStart, { days: 1 }),
      });
    case "last-30-days":
      return toAppliedPeriod({
        requested: period,
        timeZone,
        from: DateTime.subtract(dayStart, { days: rollingMonthPreviousDays }),
        toExclusive: DateTime.add(dayStart, { days: 1 }),
      });
  }
};

/** Minimal exact aggregate published to Dashboard core decisions by Transaction ownership. */
export type DashboardDirectionalAmountFact = Readonly<{
  direction: "inflow" | "outflow";
  money: ReadonlyMoney;
}>;

/** Minimal exact aggregate required to finalize one configured custom metric. */
export type DashboardMetricFact =
  | Readonly<{
      aggregation: "sum" | "maximum";
      direction: "inflow" | "outflow";
      money: ReadonlyMoney;
    }>
  | Readonly<{
      aggregation: "average";
      direction: "inflow" | "outflow";
      sum: ReadonlyMoney;
      count: bigint;
    }>;

const money = (currency: Currency, amount: ReadonlyMoney["amount"]): Money =>
  Money.make({ currency, amount });

/** Converts exact grouped sums into deterministic Currency groups with separated directions. */
export const dashboardMoneyGroupsFromSums = (
  facts: ReadonlyArray<Immutable<DashboardDirectionalAmountFact>>
): MoneyGroups => {
  const groups = new Map<
    Currency,
    { inflow: ReadonlyMoney["amount"]; outflow: ReadonlyMoney["amount"] }
  >();
  for (const fact of facts) {
    const group = groups.get(fact.money.currency) ?? { inflow: zero, outflow: zero };
    group[fact.direction] = BigDecimal.sum(group[fact.direction], fact.money.amount);
    groups.set(fact.money.currency, group);
  }
  return [...groups.keys()].sort().map((currency) => {
    const group = groups.get(currency) ?? { inflow: zero, outflow: zero };
    return {
      currency,
      inflow: money(currency, group.inflow),
      outflow: money(currency, group.outflow),
    };
  });
};

const metricMoney = (fact: Immutable<DashboardMetricFact>): ReadonlyMoney => {
  if (fact.aggregation !== "average") return fact.money;
  return money(
    fact.sum.currency,
    BigDecimal.divideUnsafe(fact.sum.amount, BigDecimal.make(fact.count, 0)).pipe(
      BigDecimal.round({
        scale: currencyMetadata(fact.sum.currency).fractionalDigits,
        mode: "half-even",
      })
    )
  );
};

/** Finalizes sum, average, or maximum without netting direction or combining Currency. */
export const dashboardMoneyGroupsFromMetrics = (
  facts: ReadonlyArray<Immutable<DashboardMetricFact>>
): MoneyGroups =>
  dashboardMoneyGroupsFromSums(
    facts.map((fact) => ({ direction: fact.direction, money: metricMoney(fact) }))
  );
