import { BigDecimal, Function, Option } from "effect";
import type { Money, MoneyGroups, ReadonlyMoney } from "~/core/_shared/money";
import type { CategoryId } from "~/core/categories/contract";
import type { EffectiveTransactionAggregate } from "~/core/transactions/contract";
import {
  type DashboardMetricFact,
  dashboardBudgetSpent,
  dashboardMoneyGroupsFromMetrics,
  dashboardMoneyGroupsFromSums,
} from "./calculation";
import type { Widget } from "./model";
import type { DashboardBucket } from "./projection";

/** Read-only interpretation of a Transaction-owner aggregate. */
type ProjectedContribution = Readonly<
  Omit<EffectiveTransactionAggregate, "sum" | "maximum"> & {
    sum: ReadonlyMoney;
    maximum: ReadonlyMoney;
  }
>;
/** One chart bucket or whole-period interval of exact Transaction-owner contributions. */
export type ProjectedRange = Readonly<{
  key: string;
  contributions: ReadonlyArray<ProjectedContribution>;
}>;

type DeepReadonly<Value> =
  Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<DeepReadonly<Item>>
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;
type AggregateWidget = DeepReadonly<Exclude<Widget, { type: "transaction-list" }>>;
type ChartWidget = DeepReadonly<Extract<Widget, { type: "spending-chart" }>>;
type MetricWidget = DeepReadonly<Extract<Widget, { type: "custom-metric" }>>;
type BudgetWidget = DeepReadonly<Extract<Widget, { type: "budget-bar" }>>;
type CategoryFact = Readonly<{ id: CategoryId; label: string }>;
type ChartGroup<Category extends CategoryFact> = Readonly<{
  key: DashboardBucket<Category>;
  moneyGroups: MoneyGroups;
}>;

const selectedContributions = (
  widget: AggregateWidget,
  contributions: ReadonlyArray<ProjectedContribution>
): ReadonlyArray<ProjectedContribution> =>
  contributions.filter((fact) =>
    widget.type === "budget-bar"
      ? fact.categoryId === widget.categoryId
      : widget.categories === undefined || widget.categories.includes(fact.categoryId)
  );

const sums = (contributions: ReadonlyArray<ProjectedContribution>): MoneyGroups =>
  dashboardMoneyGroupsFromSums(
    contributions.map((fact) => ({ direction: fact.direction, money: fact.sum }))
  );

const categoryGroups = <Category extends CategoryFact>(
  widget: ChartWidget,
  ranges: ReadonlyArray<ProjectedRange>,
  lookupCategory: (id: string) => Option.Option<Category>
): Option.Option<ReadonlyArray<ChartGroup<Category>>> => {
  const grouped = new Map<string, Array<ProjectedContribution>>();
  for (const range of ranges) {
    for (const fact of selectedContributions(widget, range.contributions)) {
      const existing = grouped.get(fact.categoryId) ?? [];
      existing.push(fact);
      grouped.set(fact.categoryId, existing);
    }
  }
  const results: Array<ChartGroup<Category>> = [];
  for (const id of [...grouped.keys()].sort()) {
    const category = lookupCategory(id);
    const contributions = grouped.get(id);
    if (Option.isNone(category) || contributions === undefined) return Option.none();
    results.push({
      key: { kind: "category", category: category.value },
      moneyGroups: sums(contributions),
    });
  }
  return Option.some(results);
};

/** Group exact projected contributions by the selected Chart dimension and Currency. */
export const projectAggregateChart = <Category extends CategoryFact>({
  widget,
  ranges,
  lookupCategory,
}: Readonly<{
  widget: ChartWidget;
  ranges: ReadonlyArray<ProjectedRange>;
  lookupCategory: (id: string) => Option.Option<Category>;
}>): Option.Option<ReadonlyArray<ChartGroup<Category>>> => {
  if (widget.groupBy === "category") return categoryGroups(widget, ranges, lookupCategory);
  const buckets: Array<ChartGroup<Category>> = [];
  for (const { key, contributions } of ranges) {
    const moneyGroups = sums(selectedContributions(widget, contributions));
    if (moneyGroups.length > 0) {
      buckets.push({
        key: widget.groupBy === "day" ? { kind: "day", date: key } : { kind: "month", month: key },
        moneyGroups,
      });
    }
  }
  return Option.some(buckets);
};

/** Combine bucket sums, maxima, and counts before finalizing one Widget's metric. */
export const projectAggregateMetric: {
  (widget: MetricWidget, ranges: ReadonlyArray<ProjectedRange>): MoneyGroups;
  (ranges: ReadonlyArray<ProjectedRange>): (widget: MetricWidget) => MoneyGroups;
} = Function.dual(2, (widget: MetricWidget, ranges: ReadonlyArray<ProjectedRange>): MoneyGroups => {
  const groups = new Map<string, ProjectedContribution>();
  for (const { contributions } of ranges) {
    for (const fact of selectedContributions(widget, contributions)) {
      const key = `${fact.sum.currency}:${fact.direction}`;
      const old = groups.get(key);
      groups.set(
        key,
        old === undefined
          ? fact
          : {
              ...fact,
              sum: {
                currency: fact.sum.currency,
                amount: BigDecimal.sum(old.sum.amount, fact.sum.amount),
              },
              maximum: {
                currency: fact.maximum.currency,
                amount: BigDecimal.max(old.maximum.amount, fact.maximum.amount),
              },
              count: old.count + fact.count,
            }
      );
    }
  }
  const metrics: ReadonlyArray<DashboardMetricFact> = [...groups.values()].map((group) =>
    widget.aggregation === "average"
      ? { aggregation: "average", direction: group.direction, sum: group.sum, count: group.count }
      : {
          aggregation: widget.aggregation,
          direction: group.direction,
          money: widget.aggregation === "maximum" ? group.maximum : group.sum,
        }
  );
  return dashboardMoneyGroupsFromMetrics(metrics);
});

/** Calculate spend only from the selected Budget Category, direction, and Currency. */
export const projectAggregateBudgetSpent: {
  (widget: BudgetWidget, ranges: ReadonlyArray<ProjectedRange>): Money;
  (ranges: ReadonlyArray<ProjectedRange>): (widget: BudgetWidget) => Money;
} = Function.dual(2, (widget: BudgetWidget, ranges: ReadonlyArray<ProjectedRange>): Money =>
  dashboardBudgetSpent(
    ranges.flatMap(({ contributions }) =>
      selectedContributions(widget, contributions).map((fact) => ({
        direction: fact.direction,
        money: fact.sum,
      }))
    ),
    widget.currency
  )
);
