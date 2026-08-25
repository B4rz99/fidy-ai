import { cleanup, render, screen, within } from "@testing-library/react";
import { BigDecimal, Cause, DateTime, Option, Schema } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardLayout, DashboardView, DashboardWidgetView } from "./presentation";
import { DashboardRouteContent } from "./view";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type BudgetResult = Extract<DashboardWidgetView["result"], { readonly availability: unknown }>;
type ListResult = Extract<DashboardWidgetView["result"], { readonly transactions: unknown }>;
type MetricResult = Extract<DashboardWidgetView["result"], { readonly moneyGroups: unknown }>;
type DashboardCategory = Extract<
  SpendingResult["buckets"][number]["key"],
  { readonly kind: "category" }
>["category"];

const chartMocks = vi.hoisted(() => ({ data: new Array<Record<string, string>>() }));

vi.mock("recharts", () => {
  const Passthrough = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
    <div>{children}</div>
  );
  const EmptyChartPart = (): JSX.Element => <div />;
  const Tooltip = ({
    formatter,
  }: Readonly<{
    formatter: (
      value: string,
      name: string,
      item: Readonly<{ payload: Record<string, string> }>
    ) => ReactNode;
  }>): JSX.Element => {
    const payload = chartMocks.data[0] ?? { inflowExact: "0", outflowExact: "0" };
    return (
      <div>
        {formatter("1", "inflow", { payload })}
        {formatter("0", "outflow", { payload })}
      </div>
    );
  };
  const BarChart = ({
    children,
    data,
  }: Readonly<{
    children: ReactNode;
    data: ReadonlyArray<Record<string, string>>;
  }>): JSX.Element => {
    chartMocks.data = [...data];
    return <div data-chart-values={JSON.stringify(data)}>{children}</div>;
  };
  return {
    Bar: EmptyChartPart,
    BarChart,
    CartesianGrid: EmptyChartPart,
    ResponsiveContainer: Passthrough,
    Tooltip,
    XAxis: EmptyChartPart,
  };
});

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
  timeZone: Schema.decodeUnknownSync(TestTimeZone)("America/Bogota"),
  calculatedAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
};
const period: SpendingResult["appliedPeriod"] = {
  requested: "this-month",
  from: DateTime.makeUnsafe("2026-07-01T05:00:00Z"),
  toExclusive: DateTime.makeUnsafe("2026-08-01T05:00:00Z"),
  timeZone: context.timeZone,
};
const ids = {
  chart: Schema.decodeUnknownSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000701"),
  budget: Schema.decodeUnknownSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000702"),
  transactions: Schema.decodeUnknownSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000703"),
  metric: Schema.decodeUnknownSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000704"),
  category: Schema.decodeUnknownSync(TestCategoryId)("f1d1a000-0000-4000-8000-000000000705"),
};
const category: DashboardCategory = {
  id: ids.category,
  label: Schema.decodeUnknownSync(TestCategoryLabel)("Restaurantes"),
};

type FixtureOptions = Readonly<{
  budgetState: "missing" | "under" | "reached" | "over";
  chartEmpty: boolean;
  exact: boolean;
  metricEmpty: boolean;
  transactionEmpty: boolean;
  transactionInflow: boolean;
}>;
const transactionListLimit = 5;

const standardOptions: FixtureOptions = {
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
            id: Schema.decodeUnknownSync(TestCategoryId)("f1d1a000-0000-4000-8000-000000000707"),
            label: Schema.decodeUnknownSync(TestCategoryLabel)("Transporte"),
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
          id: Schema.decodeUnknownSync(TestTransactionId)("f1d1a000-0000-4000-8000-000000000706"),
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
      weight: Schema.decodeUnknownSync(TestSplitWeight)(1),
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
      weight: Schema.decodeUnknownSync(TestSplitWeight)(1),
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
      weight: Schema.decodeUnknownSync(TestSplitWeight)(1),
      node: {
        kind: "leaf",
        widget: {
          widget: {
            id: ids.transactions,
            type: "transaction-list",
            limit: Schema.decodeUnknownSync(TestTransactionListLimit)(transactionListLimit),
          },
          result: listResult(options),
        },
      },
    },
    {
      weight: Schema.decodeUnknownSync(TestSplitWeight)(1),
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

const makeView = (options: FixtureOptions): DashboardView => ({
  title: Schema.decodeUnknownSync(Schema.NonEmptyString)("Mi tablero"),
  context,
  layout: {
    kind: "split",
    axis: "row",
    children: [
      { weight: Schema.decodeUnknownSync(TestSplitWeight)(2), node: leftLayout(options) },
      { weight: Schema.decodeUnknownSync(TestSplitWeight)(1), node: rightLayout(options) },
    ],
  },
});

const renderDashboardView = async (data: DashboardView): Promise<void> => {
  render(<DashboardRouteContent result={AsyncResult.success({ data })} />);
  await screen.findByLabelText("Diseño responsivo del tablero");
};

beforeEach(() => {
  chartMocks.data = [];
});
afterEach(cleanup);

describe("read-only Dashboard resources", () => {
  it("renders the loading state for an initial canonical Dashboard snapshot", () => {
    render(<DashboardRouteContent result={AsyncResult.initial()} />);
    expect(screen.getByLabelText("Cargando tablero")).toBeVisible();
  });

  it("renders a canonical failure without exposing its cause", async () => {
    render(
      <DashboardRouteContent
        result={AsyncResult.failure(Cause.fail(new Error("canonical failure")))}
      />
    );
    expect(await screen.findByText("No pudimos cargar tu tablero")).toBeVisible();
    expect(screen.queryByText("canonical failure")).not.toBeInTheDocument();
  });
});

describe("read-only Dashboard responsive rendering", () => {
  it("uses one recursive DOM tree with mobile columns, desktop axes, weights, and stable order", async () => {
    await renderDashboardView(makeView(standardOptions));
    const dashboard = within(screen.getByLabelText("Diseño responsivo del tablero"));
    expect(
      dashboard.getAllByRole("heading", { level: 2 }).map(({ textContent }) => textContent)
    ).toEqual(["Transacciones", "Presupuesto", "Transacciones recientes", "Promedio mensual"]);
    expect(screen.getByTestId("responsive-weight-2")).toHaveStyle({
      "--dashboard-weight": "2",
    });
    expect(screen.getByLabelText("Diseño responsivo del tablero").firstElementChild).toHaveClass(
      "flex-col",
      "md:flex-row"
    );
  });

  it("renders colocated Categories, separated directions, and Currency without repeated zones", async () => {
    await renderDashboardView(makeView(standardOptions));
    const dashboard = within(screen.getByLabelText("Diseño responsivo del tablero"));
    expect(dashboard.getAllByText("Restaurantes").length).toBeGreaterThan(0);
    expect(dashboard.getAllByText("COP").length).toBeGreaterThan(1);
    const spendingHeading = dashboard.getAllByRole("heading", { level: 2 })[0];
    if (spendingHeading === undefined) throw new Error("Expected the spending heading");
    const spendingCard = spendingHeading.closest('[data-slot="card"]');
    expect(spendingCard).not.toBeNull();
    if (!(spendingCard instanceof HTMLElement)) throw new Error("Expected the spending Card");
    expect(within(spendingCard).queryByText("Ingresos")).not.toBeInTheDocument();
    expect(within(spendingCard).getByText("Gastos")).toBeVisible();
    expect(dashboard.getByText("El Corral")).toBeVisible();
    expect(dashboard.queryByText("America/Bogota")).not.toBeInTheDocument();
    expect(screen.queryByText(/Zona horaria aplicada/u)).not.toBeInTheDocument();
  });
});

describe("Dashboard result and Money states", () => {
  it("renders explicit missing, reached, over, empty, and inflow states", async () => {
    await renderDashboardView(makeView({ ...standardOptions, budgetState: "missing" }));
    expect(screen.getByText("No hay presupuesto configurado")).toBeVisible();
    cleanup();
    await renderDashboardView(
      makeView({
        ...standardOptions,
        budgetState: "over",
        chartEmpty: true,
        metricEmpty: true,
        transactionEmpty: true,
        transactionInflow: true,
      })
    );
    expect(screen.getByText("No hay transacciones en este periodo")).toBeVisible();
    expect(screen.getByText("No hay transacciones para mostrar")).toBeVisible();
    expect(screen.getByText("No hay transacciones para calcular")).toBeVisible();
    expect(screen.getByText(/Excedido por/u)).toBeVisible();
    cleanup();
    await renderDashboardView(makeView({ ...standardOptions, transactionInflow: true }));
    expect(screen.getByText("Ingreso")).toBeVisible();
    expect(screen.getByText("Sin contraparte")).toBeVisible();
    cleanup();
    await renderDashboardView(makeView({ ...standardOptions, budgetState: "reached" }));
    expect(screen.getByText("Presupuesto alcanzado")).toBeVisible();
  });

  it("keeps exact Money tooltips correlated to their row while geometry stays bounded", async () => {
    await renderDashboardView(makeView({ ...standardOptions, exact: true }));
    expect(
      screen.getAllByText(
        (_text, element) => element?.textContent.includes("USD 9.007.199.254.740.993,12") ?? false
      ).length
    ).toBeGreaterThan(0);
    const chart = document.querySelector("[data-chart-values]");
    expect(chart?.getAttribute("data-chart-values")).not.toContain("inflowExact");
    expect(chart?.getAttribute("data-chart-values")).not.toContain('"inflow":');
    expect(screen.queryByText(/9\.007\.199\.254\.740\.993,13/u)).not.toBeInTheDocument();
  });
});
