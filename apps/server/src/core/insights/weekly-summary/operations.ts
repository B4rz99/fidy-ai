import { Array, BigDecimal, DateTime, Option, Order } from "effect";
import {
  type Currency,
  type Money,
  type ReadonlyMoney,
  encodeMoneyAmount,
} from "../../_shared/money";
import type { IanaTimeZone } from "../../_shared/context";
import type { Category, CategoryId } from "../../categories/contract";
import type { TransactionPeriod } from "../../transactions/contract";
import { WeeklyPeriods } from "../contract";
import {
  type WeeklyComparison,
  type WeeklySummaryOutcome,
  WeeklySummaryPayload,
  type WeeklySummaryPresentation,
} from "./contract";

type AggregateView = Readonly<{
  categoryId: CategoryId;
  direction: "inflow" | "outflow";
  sum: ReadonlyMoney;
}>;
const zero = BigDecimal.make(0n, 0);
const total = (
  facts: ReadonlyArray<AggregateView>,
  currency: Currency,
  direction: "inflow" | "outflow"
): Money => ({
  currency,
  amount: BigDecimal.sumAll(
    facts
      .filter((fact) => fact.sum.currency === currency && fact.direction === direction)
      .map((fact) => fact.sum.amount)
  ),
});
const compare = (current: ReadonlyMoney, previous: ReadonlyMoney): WeeklyComparison => {
  const order = BigDecimal.Order(current.amount, previous.amount);
  let change: WeeklyComparison["change"] = "Unchanged";
  if (order > 0) change = "Increased";
  if (order < 0) change = "Decreased";
  return {
    current: { ...current },
    previous: { ...previous },
    change,
    absoluteDelta: {
      currency: current.currency,
      amount: BigDecimal.abs(BigDecimal.subtract(current.amount, previous.amount)),
    },
  };
};
const leaders = (
  facts: ReadonlyArray<AggregateView>,
  currency: Currency
): ReadonlyArray<Readonly<{ categoryId: CategoryId; outflow: Money }>> => {
  const categories = new Map<CategoryId, BigDecimal.BigDecimal>();
  for (const fact of facts) {
    if (fact.direction === "outflow" && fact.sum.currency === currency) {
      categories.set(
        fact.categoryId,
        BigDecimal.sum(categories.get(fact.categoryId) ?? zero, fact.sum.amount)
      );
    }
  }
  return [...categories.entries()]
    .filter((entry: readonly [CategoryId, Readonly<BigDecimal.BigDecimal>]) =>
      BigDecimal.isPositive(entry[1])
    )
    .sort(
      (
        left: readonly [CategoryId, Readonly<BigDecimal.BigDecimal>],
        right: readonly [CategoryId, Readonly<BigDecimal.BigDecimal>]
      ) => BigDecimal.Order(right[1], left[1]) || Order.String(left[0], right[0])
    )
    .slice(0, 3)
    .map((entry: readonly [CategoryId, Readonly<BigDecimal.BigDecimal>]) => ({
      categoryId: entry[0],
      outflow: { amount: entry[1], currency },
    }));
};
/** Consume complete Transaction-owned facts from one revision; callers guard that revision when freezing the report. */
export const summarizeWeek = (
  input: Readonly<{
    periods: WeeklyPeriods;
    financialRevision: number;
    current: ReadonlyArray<AggregateView>;
    previous: ReadonlyArray<AggregateView>;
  }>
): WeeklySummaryOutcome => {
  WeeklyPeriods.make(input.periods);
  if (input.current.every((fact) => BigDecimal.isZero(fact.sum.amount))) {
    return { _tag: "NoActivity" };
  }
  const currencies = [
    ...new Set([...input.current, ...input.previous].map((fact) => fact.sum.currency)),
  ].sort();
  const groups = currencies.map((currency) => ({
    currency,
    inflow: compare(
      total(input.current, currency, "inflow"),
      total(input.previous, currency, "inflow")
    ),
    outflow: compare(
      total(input.current, currency, "outflow"),
      total(input.previous, currency, "outflow")
    ),
    topOutflowCategories: leaders(input.current, currency),
  }));
  if (!Array.isReadonlyArrayNonEmpty(groups)) return { _tag: "NoActivity" };
  return {
    _tag: "Summary",
    payload: WeeklySummaryPayload.make({
      periods: input.periods,
      financialRevision: input.financialRevision,
      groups,
    }),
  };
};

const localCutoff = (at: DateTime.Utc, timeZone: IanaTimeZone): string => {
  const parts = DateTime.toParts(DateTime.setZone(at, DateTime.zoneMakeNamedUnsafe(timeZone)));
  return `${parts.day}/${parts.month}/${parts.year} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
};
type ComparisonPresentation = Readonly<{
  current: ReadonlyMoney;
  change: WeeklyComparison["change"];
  absoluteDelta: ReadonlyMoney;
}>;
type GroupPresentation = Readonly<{
  currency: Currency;
  inflow: ComparisonPresentation;
  outflow: ComparisonPresentation;
  topOutflowCategories: ReadonlyArray<Readonly<{ categoryId: CategoryId; outflow: ReadonlyMoney }>>;
}>;
const changeText: Readonly<Record<WeeklyComparison["change"], string>> = {
  Increased: "aumentaron",
  Decreased: "disminuyeron",
  Unchanged: "sin cambio",
};
const comparisonText = (comparison: ComparisonPresentation): string =>
  `${encodeMoneyAmount(comparison.current.amount).replace(".", ",")} (${changeText[comparison.change]}: ${encodeMoneyAmount(comparison.absoluteDelta.amount).replace(".", ",")})`;

/** Present validated frozen report facts deterministically in Spanish. Missing Category metadata refuses the whole presentation; no Currency or leader is silently omitted. */
export const presentWeeklySummary = (
  input: Readonly<{
    payload: Readonly<{ periods: WeeklyPeriods; groups: ReadonlyArray<GroupPresentation> }>;
    categories: ReadonlyArray<Category>;
    timeZone: IanaTimeZone;
  }>
): Option.Option<WeeklySummaryPresentation> => {
  const labels = new Map(
    input.categories.map((category) => [category.id, category.label] as const)
  );
  const sections: Array<Readonly<{ currency: Currency; text: string }>> = [];
  for (const group of input.payload.groups) {
    const leaders: Array<string> = [];
    for (const category of group.topOutflowCategories) {
      const label = labels.get(category.categoryId);
      if (label === undefined) return Option.none();
      leaders.push(`${label} ${encodeMoneyAmount(category.outflow.amount).replace(".", ",")}`);
    }
    const categories = leaders.length === 0 ? "" : ` Categorías: ${leaders.join(", ")}.`;
    sections.push({
      currency: group.currency,
      text: `Ingresos ${comparisonText(group.inflow)}; salidas ${comparisonText(group.outflow)}.${categories}`,
    });
  }
  return Option.some({
    period: `Del ${localCutoff(input.payload.periods.current.from, input.timeZone)} al ${localCutoff(input.payload.periods.current.toExclusive, input.timeZone)} (${input.timeZone})`,
    currencies: sections.map((section) => section.currency),
    sections,
  });
};

const samePeriod = (left: TransactionPeriod, right: TransactionPeriod): boolean =>
  left.from.epochMilliseconds === right.from.epochMilliseconds &&
  left.toExclusive.epochMilliseconds === right.toExclusive.epochMilliseconds;
/** Build from a complete Transaction snapshot, first current then previous. Mismatched bounds are a caller invariant defect, never no activity. */
export const buildWeeklySummary = (
  input: Readonly<{
    periods: WeeklyPeriods;
    facts: Readonly<{
      revision: number;
      periods: readonly [
        Readonly<{ period: TransactionPeriod; aggregates: ReadonlyArray<AggregateView> }>,
        Readonly<{ period: TransactionPeriod; aggregates: ReadonlyArray<AggregateView> }>,
      ];
    }>;
  }>
): WeeklySummaryOutcome => {
  const [current, previous] = input.facts.periods;
  if (
    !samePeriod(input.periods.current, current.period) ||
    !samePeriod(input.periods.previous, previous.period)
  ) {
    throw new Error("Weekly aggregate bounds do not match captured report periods");
  }
  return summarizeWeek({
    periods: input.periods,
    financialRevision: input.facts.revision,
    current: current.aggregates,
    previous: previous.aggregates,
  });
};
