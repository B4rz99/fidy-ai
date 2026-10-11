import { BigDecimal, DateTime, Option, Schema } from "effect";
import type { DashboardLayout, DashboardView, DashboardWidgetView } from "./presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type BudgetResult = Extract<DashboardWidgetView["result"], { readonly availability: unknown }>;
type ListResult = Extract<DashboardWidgetView["result"], { readonly transactions: unknown }>;
type MetricResult = Extract<DashboardWidgetView["result"], { readonly moneyGroups: unknown }>;
type DashboardCategory = Extract<
  SpendingResult["buckets"][number]["key"],
  { readonly kind: "category" }
>["category"];

const TestWidgetId = Schema.String.pipe(Schema.brand("WidgetId"));
const TestCategoryId = Schema.String.pipe(Schema.brand("CategoryId"));
const TestTransactionId = Schema.String.pipe(Schema.brand("TransactionId"));
const TestCategoryLabel = Schema.NonEmptyString.pipe(Schema.brand("CategoryLabel"));
const TestSplitWeight = Schema.Finite.pipe(Schema.brand("SplitWeight"));
const TestTransactionListLimit = Schema.Finite.pipe(Schema.brand("TransactionListLimit"));
const TestTimeZone = Schema.String.pipe(Schema.brand("IanaTimeZone"));

const money = (
  amount: string,
  currency: "COP" | "USD"
): Readonly<{ amount: BigDecimal.BigDecimal; currency: "COP" | "USD" }> => ({
  amount: BigDecimal.fromStringUnsafe(amount),
  currency,
});
const context: DashboardView["context"] = {
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: Schema.decodeSync(TestTimeZone)("America/Bogota"),
  calculatedAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
};
const period: SpendingResult["appliedPeriod"] = {
  requested: "this-month",
  from: DateTime.makeUnsafe("2026-07-01T05:00:00Z"),
  toExclusive: DateTime.makeUnsafe("2026-08-01T05:00:00Z"),
  timeZone: context.timeZone,
};
export const ids = {
  chart: Schema.decodeSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000701"),
  budget: Schema.decodeSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000702"),
  transactions: Schema.decodeSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000703"),
  metric: Schema.decodeSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000704"),
  category: Schema.decodeSync(TestCategoryId)("f1d1a000-0000-4000-8000-000000000705"),
};
const category: DashboardCategory = {
  id: ids.category,
  label: Schema.decodeSync(TestCategoryLabel)("Restaurantes"),
};

export type FixtureOptions = Readonly<{
  budgetState: "missing" | "under" | "reached" | "over";
  chartEmpty: boolean;
  exact: boolean;
  metricEmpty: boolean;
  transactionEmpty: boolean;
  transactionInflow: boolean;
}>;
const transactionListLimit = 5;

export const standardOptions: FixtureOptions = {
  budgetState: "under",
  chartEmpty: false,
  exact: false,
  metricEmpty: false,
  transactionEmpty: false,
  transactionInflow: false,
};

const budgetResult = (state: FixtureOptions["budgetState"]): BudgetResult => {
  switch (state) {
    case "missing":
      return { availability: "missing-budget", appliedPeriod: period, category, currency: "COP" };
    case "reached":
      return {
        availability: "available",
        appliedPeriod: period,
        category,
        currency: "COP",
        cap: money("25000", "COP"),
        spent: money("25000", "COP"),
        status: { type: "reached" },
      };
    case "over":
      return {
        availability: "available",
        appliedPeriod: period,
        category,
        currency: "COP",
        cap: money("10000", "COP"),
        spent: money("25000", "COP"),
        status: { type: "over", overBy: money("15000", "COP") },
      };
    case "under":
      return {
        availability: "available",
        appliedPeriod: period,
        category,
        currency: "COP",
        cap: money("100000", "COP"),
        spent: money("25000", "COP"),
        status: { type: "under", remaining: money("75000", "COP") },
      };
  }
};

const chartResult = (options: FixtureOptions): SpendingResult => {
  const currency = options.exact ? "USD" : "COP";
  const amount = options.exact ? "9007199254740993.12" : "100000";
  const firstBucket: SpendingResult["buckets"][number] = {
    key: { kind: "category", category },
    moneyGroups: [{ currency, inflow: money(amount, currency), outflow: money("25000", currency) }],
  };
  let buckets: SpendingResult["buckets"] = [firstBucket];
  if (options.chartEmpty) {
    buckets = [
      {
        ...firstBucket,
        moneyGroups: [
          {
            currency,
            inflow: money(amount, currency),
            outflow: money("0", currency),
          },
        ],
      },
    ];
  } else if (options.exact) {
    buckets = [
      firstBucket,
      {
        key: {
          kind: "category",
          category: {
            id: Schema.decodeSync(TestCategoryId)("f1d1a000-0000-4000-8000-000000000707"),
            label: Schema.decodeSync(TestCategoryLabel)("Transporte"),
          },
        },
        moneyGroups: [
          {
            currency: "COP",
            inflow: money("100000", "COP"),
            outflow: money("25000", "COP"),
          },
        ],
      },
    ];
  }
  return { appliedPeriod: period, buckets };
};

const metricResult = (options: FixtureOptions): MetricResult => {
  const currency = options.exact ? "USD" : "COP";
  const amount = options.exact ? "9007199254740993.12" : "100000";
  return {
    appliedPeriod: period,
    moneyGroups: options.metricEmpty
      ? []
      : [{ currency, inflow: money(amount, currency), outflow: money("25000", currency) }],
  };
};

const listResult = (options: FixtureOptions): ListResult => ({
  transactions: options.transactionEmpty
    ? []
    : [
        {
          id: Schema.decodeSync(TestTransactionId)("f1d1a000-0000-4000-8000-000000000706"),
          category,
          counterparty: options.transactionInflow ? Option.none() : Option.some("El Corral"),
          direction: options.transactionInflow ? "inflow" : "outflow",
          money: money("25000", "COP"),
          occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
        },
      ],
});

const leftLayout = (options: FixtureOptions): DashboardLayout => ({
  kind: "split",
  axis: "column",
  children: [
    {
      weight: Schema.decodeSync(TestSplitWeight)(1),
      node: {
        kind: "leaf",
        widget: {
          widget: {
            id: ids.chart,
            type: "spending-chart",
            groupBy: "category",
            period: "this-month",
          },
          result: chartResult(options),
        },
      },
    },
    {
      weight: Schema.decodeSync(TestSplitWeight)(1),
      node: {
        kind: "leaf",
        widget: {
          widget: {
            id: ids.budget,
            type: "budget-bar",
            categoryId: ids.category,
            currency: "COP",
          },
          result: budgetResult(options.budgetState),
        },
      },
    },
  ],
});

const rightLayout = (options: FixtureOptions): DashboardLayout => ({
  kind: "split",
  axis: "column",
  children: [
    {
      weight: Schema.decodeSync(TestSplitWeight)(1),
      node: {
        kind: "leaf",
        widget: {
          widget: {
            id: ids.transactions,
            type: "transaction-list",
            limit: Schema.decodeSync(TestTransactionListLimit)(transactionListLimit),
          },
          result: listResult(options),
        },
      },
    },
    {
      weight: Schema.decodeSync(TestSplitWeight)(1),
      node: {
        kind: "leaf",
        widget: {
          widget: {
            id: ids.metric,
            type: "custom-metric",
            label: "Promedio mensual",
            aggregation: "average",
            period: "this-month",
          },
          result: metricResult(options),
        },
      },
    },
  ],
});

export const makeView = (options: FixtureOptions): DashboardView => ({
  title: Schema.decodeSync(Schema.NonEmptyString)("Mi tablero"),
  context,
  layout: {
    kind: "split",
    axis: "row",
    children: [
      { weight: Schema.decodeSync(TestSplitWeight)(2), node: leftLayout(options) },
      { weight: Schema.decodeSync(TestSplitWeight)(1), node: rightLayout(options) },
    ],
  },
});

/** Canonical ordered catalog, encoded as it appears on the browser API. */
export const catalog = [
  {
    id: "monthly-spending",
    name: "Gastos del mes",
    description: "Gastos por categoría",
    widget: { type: "spending-chart", groupBy: "category", period: "this-month" },
  },
  {
    id: "restaurant-budget-cop",
    name: "Presupuesto",
    description: "Presupuesto mensual",
    widget: { type: "budget-bar", categoryId: ids.category, currency: "COP" },
  },
  {
    id: "recent-transactions",
    name: "Transacciones recientes",
    description: "Últimos movimientos",
    widget: { type: "transaction-list", limit: 10 },
  },
  {
    id: "monthly-outflows",
    name: "Salidas del mes",
    description: "Resumen mensual",
    widget: {
      type: "custom-metric",
      label: "Salidas del mes",
      aggregation: "sum",
      period: "this-month",
    },
  },
];
