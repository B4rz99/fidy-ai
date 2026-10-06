import { type Category, type CategoryId } from "~/core/categories/contract";
import {
  type AppliedDashboardPeriod,
  type CustomMetricWidget,
  type DashboardCatalog,
  DashboardCatalogEntry,
  type DashboardCategoryReference,
  type DashboardChartBucket,
  type DashboardDirectionalAmountFact,
  type DashboardDocument,
  type DashboardEdit,
  type DashboardFailure,
  type DashboardMetricFact,
  DashboardPeriod,
  type DashboardProjectionRange,
  DashboardTitle,
  type LayoutNode,
  type LeafNode,
  type ProjectedContribution,
  type ProjectedRange,
  type SpendingChartWidget,
  SpendingGroupBy,
  SplitWeight,
  TransactionListLimit,
  type TransactionListWidget,
  Widget,
  type WidgetId,
} from "./contract";
import { BigDecimal, DateTime, Effect, Function, Option } from "effect";
import { type IanaTimeZone } from "~/core/_shared/context";
import {
  type Currency,
  Money,
  type MoneyGroups,
  type ReadonlyMoney,
  currencyMetadata,
} from "~/core/_shared/money";
import { layoutLeaves } from "~/core/dashboard/internal/layout";
import {
  applyAdd,
  applyMove,
  applyRemove,
  applyResize,
  applySwap,
  applyUpdate,
  revalidateDocument,
} from "~/core/dashboard/internal/rules";

const recentTransactionsPresetLimit = 10;

const monthlySpending = DashboardCatalogEntry.make({
  id: "monthly-spending",
  name: "Gastos del mes",
  description: "Compara entradas y salidas del mes por categoría y moneda.",
  widget: {
    type: "spending-chart",
    title: "Gastos por categoría",
    groupBy: SpendingGroupBy.make("category"),
    period: DashboardPeriod.make("this-month"),
  },
});

const restaurantBudgetCop = (categoryId: CategoryId): DashboardCatalogEntry =>
  DashboardCatalogEntry.make({
    id: "restaurant-budget-cop",
    name: "Presupuesto de restaurantes",
    description: "Sigue el presupuesto mensual de restaurantes expresado en COP.",
    widget: {
      type: "budget-bar",
      title: "Presupuesto de restaurantes",
      categoryId,
      currency: "COP",
    },
  });

const recentTransactions = DashboardCatalogEntry.make({
  id: "recent-transactions",
  name: "Transacciones recientes",
  description: "Muestra las diez transacciones más recientes con su moneda original.",
  widget: {
    type: "transaction-list",
    title: "Transacciones recientes",
    limit: TransactionListLimit.make(recentTransactionsPresetLimit),
  },
});

const monthlyOutflows = DashboardCatalogEntry.make({
  id: "monthly-outflows",
  name: "Salidas del mes",
  description: "Resume las salidas del mes sin mezclar monedas ni calcular un neto.",
  widget: {
    type: "custom-metric",
    label: "Salidas del mes",
    aggregation: "sum",
    period: DashboardPeriod.make("this-month"),
  },
});

/** Builds the four direct-launch presets from the shell-supplied restaurant CategoryId. */
export const makeDashboardCatalog = (
  input: Readonly<{ readonly restaurantCategoryId: CategoryId }>
): DashboardCatalog => [
  monthlySpending,
  restaurantBudgetCop(input.restaurantCategoryId),
  recentTransactions,
  monthlyOutflows,
];

/** Assigns caller-generated identity to one already-valid catalog template. */
export const makeCatalogWidget = (
  input: Readonly<{
    readonly entry: DashboardCatalogEntry;
    readonly id: WidgetId;
  }>
): Widget => ({ ...input.entry.widget, id: input.id });

type DefaultWidgetIds = readonly [WidgetId, WidgetId, WidgetId, WidgetId];

const defaultWeight = SplitWeight.make(1);

const defaultLeaf = (entry: DashboardCatalogEntry, id: WidgetId): LeafNode => ({
  kind: "leaf",
  widget: makeCatalogWidget({ entry, id }),
});

/** Creates the four-Widget, two-by-two first-use document retained for one User. */
export const makeDefaultDashboard = (
  input: Readonly<{
    readonly restaurantCategoryId: CategoryId;
    readonly widgetIds: DefaultWidgetIds;
  }>
): DashboardDocument => {
  const catalog = makeDashboardCatalog({ restaurantCategoryId: input.restaurantCategoryId });
  const [firstId, secondId, thirdId, fourthId] = input.widgetIds;
  const first = defaultLeaf(catalog[0], firstId);
  const second = defaultLeaf(catalog[1], secondId);
  const third = defaultLeaf(catalog[2], thirdId);
  const fourth = defaultLeaf(catalog[3], fourthId);
  return {
    title: DashboardTitle.make("Tablero"),
    layout: {
      kind: "split",
      axis: "column",
      children: [
        {
          weight: defaultWeight,
          node: {
            kind: "split",
            axis: "row",
            children: [
              { weight: defaultWeight, node: first },
              { weight: defaultWeight, node: second },
            ],
          },
        },
        {
          weight: defaultWeight,
          node: {
            kind: "split",
            axis: "row",
            children: [
              { weight: defaultWeight, node: third },
              { weight: defaultWeight, node: fourth },
            ],
          },
        },
      ],
    },
  };
};

const rollingWeekPreviousDays = 6;

const rollingMonthPreviousDays = 29;

const zero = BigDecimal.make(0n, 0);

type PeriodInput = Readonly<{
  now: DateTime.Utc;
  period: DashboardPeriod;
  timeZone: IanaTimeZone;
}>;

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
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(weekStart),
        toExclusive: DateTime.toUtc(DateTime.add(weekStart, { weeks: 1 })),
      };
    case "this-month":
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(monthStart),
        toExclusive: DateTime.toUtc(DateTime.add(monthStart, { months: 1 })),
      };
    case "last-week":
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(DateTime.subtract(weekStart, { weeks: 1 })),
        toExclusive: DateTime.toUtc(weekStart),
      };
    case "last-month":
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(DateTime.subtract(monthStart, { months: 1 })),
        toExclusive: DateTime.toUtc(monthStart),
      };
    case "last-7-days":
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(DateTime.subtract(dayStart, { days: rollingWeekPreviousDays })),
        toExclusive: DateTime.toUtc(DateTime.add(dayStart, { days: 1 })),
      };
    case "last-30-days":
      return {
        requested: period,
        timeZone,
        from: DateTime.toUtc(DateTime.subtract(dayStart, { days: rollingMonthPreviousDays })),
        toExclusive: DateTime.toUtc(DateTime.add(dayStart, { days: 1 })),
      };
  }
};

const money = (currency: Currency, amount: ReadonlyMoney["amount"]): Money =>
  Money.make({ currency, amount });

/** Converts exact grouped sums into deterministic Currency groups with separated directions. */
export const dashboardMoneyGroupsFromSums = (
  facts: ReadonlyArray<DashboardDirectionalAmountFact>
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

const metricMoney = (fact: DashboardMetricFact): ReadonlyMoney => {
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
  facts: ReadonlyArray<DashboardMetricFact>
): MoneyGroups =>
  dashboardMoneyGroupsFromSums(
    facts.map((fact) => ({ direction: fact.direction, money: metricMoney(fact) }))
  );

/** Exact outflow spend for the selected Budget Currency, never netted with income. */
const dashboardBudgetSpent: {
  (facts: ReadonlyArray<DashboardDirectionalAmountFact>, currency: Currency): Money;
  (currency: Currency): (facts: ReadonlyArray<DashboardDirectionalAmountFact>) => Money;
} = Function.dual(
  2,
  (facts: ReadonlyArray<DashboardDirectionalAmountFact>, currency: Currency): Money =>
    money(
      currency,
      facts.reduce(
        (total: Readonly<ReadonlyMoney["amount"]>, fact) =>
          fact.direction === "outflow" && fact.money.currency === currency
            ? BigDecimal.sum(total, fact.money.amount)
            : total,
        zero
      )
    )
);

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

const categoryGroups = (
  widget: ChartWidget,
  ranges: ReadonlyArray<ProjectedRange>,
  lookupCategory: (id: string) => Option.Option<Category>
): Option.Option<ReadonlyArray<DashboardChartBucket>> => {
  const grouped = new Map<string, Array<ProjectedContribution>>();
  for (const range of ranges) {
    for (const fact of selectedContributions(widget, range.contributions)) {
      const existing = grouped.get(fact.categoryId) ?? [];
      existing.push(fact);
      grouped.set(fact.categoryId, existing);
    }
  }
  const results: Array<DashboardChartBucket> = [];
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
export const projectAggregateChart = ({
  widget,
  ranges,
  lookupCategory,
}: Readonly<{
  widget: ChartWidget;
  ranges: ReadonlyArray<ProjectedRange>;
  lookupCategory: (id: string) => Option.Option<Category>;
}>): Option.Option<ReadonlyArray<DashboardChartBucket>> => {
  if (widget.groupBy === "category") return categoryGroups(widget, ranges, lookupCategory);
  const buckets: Array<DashboardChartBucket> = [];
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

const monthCharacters = 7;

const dayCharacters = 10;

/** Resolve requested periods and local chart buckets without consulting retained history. */
export const dashboardProjectionRanges: {
  (
    widget: Exclude<Widget, { type: "transaction-list" }>,
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): ReadonlyArray<DashboardProjectionRange>;
  (
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): (
    widget: Exclude<Widget, { type: "transaction-list" }>
  ) => ReadonlyArray<DashboardProjectionRange>;
} = Function.dual(
  3,
  (
    widget: Exclude<Widget, { type: "transaction-list" }>,
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): ReadonlyArray<DashboardProjectionRange> => {
    const period = resolveDashboardPeriod({
      now,
      period: widget.type === "budget-bar" ? "this-month" : widget.period,
      timeZone,
    });
    if (widget.type !== "spending-chart" || widget.groupBy === "category") {
      return [
        {
          key: "",
          from: period.from.epochMilliseconds,
          toExclusive: period.toExclusive.epochMilliseconds,
        },
      ];
    }
    const ranges: Array<DashboardProjectionRange> = [];
    const zone = DateTime.zoneMakeNamedUnsafe(timeZone);
    let start = DateTime.setZone(period.from, zone);
    while (DateTime.Order(DateTime.toUtc(start), period.toExclusive) < 0) {
      const next = DateTime.add(start, widget.groupBy === "day" ? { days: 1 } : { months: 1 });
      const nextUtc = DateTime.toUtc(next);
      ranges.push({
        key: DateTime.formatIsoDate(start).slice(
          0,
          widget.groupBy === "day" ? dayCharacters : monthCharacters
        ),
        from: DateTime.toUtc(start).epochMilliseconds,
        toExclusive: Math.min(nextUtc.epochMilliseconds, period.toExclusive.epochMilliseconds),
      });
      start = next;
    }
    return ranges;
  }
);

/** Traverse the validated layout in the same order used for its mobile presentation. */
export const collectLayoutWidgets = (node: Readonly<LayoutNode>): ReadonlyArray<Widget> =>
  layoutLeaves(node).map((leaf) => leaf.widget);

/** The Widgets whose Category filter is optional; absence is not an empty filter. */
type FilteredWidget = SpendingChartWidget | TransactionListWidget | CustomMetricWidget;

const collectFilteredWidgetReferences = (
  widget: Readonly<FilteredWidget>
): ReadonlyArray<DashboardCategoryReference> =>
  widget.categories === undefined
    ? []
    : widget.categories.map((categoryId, index) => ({
        categoryId,
        widgetId: widget.id,
        field: `categories.${index}` satisfies `categories.${number}`,
      }));

/** Collects Category references without exposing recursive traversal to the shell. */
export const collectDashboardCategoryReferences = (
  document: Readonly<DashboardDocument>
): ReadonlyArray<DashboardCategoryReference> =>
  collectLayoutWidgets(document.layout).flatMap(
    Widget.match({
      "budget-bar": (widget) => [
        { categoryId: widget.categoryId, widgetId: widget.id, field: "categoryId" as const },
      ],
      "spending-chart": collectFilteredWidgetReferences,
      "transaction-list": collectFilteredWidgetReferences,
      "custom-metric": collectFilteredWidgetReferences,
    })
  );

/**
 * Applies one decoded UI-or-agent edit and re-proves the complete result.
 * Fails for absent targets, duplicate or self placement, removing the last Widget, resizing the
 * root region, or any edit whose complete result violates Dashboard invariants.
 */
export const applyDashboardEdit = (
  input: Readonly<{
    readonly document: DashboardDocument;
    readonly edit: DashboardEdit;
  }>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  Effect.suspend(() => {
    switch (input.edit.op) {
      case "set-title":
        return revalidateDocument({ ...input.document, title: input.edit.title });
      case "add-widget":
        return applyAdd({ document: input.document, edit: input.edit, duplicatePolicy: "reject" });
      case "remove-widget":
        return applyRemove({ document: input.document, widgetId: input.edit.widgetId });
      case "move-widget":
        return applyMove({ document: input.document, edit: input.edit });
      case "swap-widgets":
        return applySwap({ document: input.document, edit: input.edit });
      case "resize-region":
        return applyResize({ document: input.document, edit: input.edit });
      case "update-widget":
        return applyUpdate({ document: input.document, widget: input.edit.widget });
    }
  });
