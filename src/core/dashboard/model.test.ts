import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  BudgetBarData,
  collectDashboardCategoryReferences,
  CustomMetricData,
  DashboardDocument,
  DashboardMoneyGroups,
  SpendingChartData,
} from "./model";

const categoryId = "10000000-0000-4000-8000-000000000001";

it("decodes the one User dashboard without storage identity or format fields", () => {
  const document = Schema.decodeUnknownSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "leaf",
      widget: {
        id: "f1d1a000-0000-4000-8000-000000000301",
        type: "spending-chart",
        title: "Gastos por categoría",
        groupBy: "category",
        period: "this-month",
      },
    },
  });

  expect(document.title).toBe("Mi tablero");
  expect(document.layout.kind).toBe("leaf");
  if (document.layout.kind === "leaf") {
    expect(document.layout.widget.type).toBe("spending-chart");
    expect(document.layout.widget.title).toBe("Gastos por categoría");
  }
});

it("decodes every closed widget variant without implicit monetary defaults", () => {
  const widgets = [
    {
      id: "f1d1a000-0000-4000-8000-000000000311",
      type: "spending-chart",
      groupBy: "month",
      period: "last-30-days",
      categories: [categoryId],
    },
    {
      id: "f1d1a000-0000-4000-8000-000000000312",
      type: "budget-bar",
      categoryId,
      currency: "USD",
    },
    {
      id: "f1d1a000-0000-4000-8000-000000000313",
      type: "transaction-list",
      limit: 10,
      search: "Mercado",
    },
    {
      id: "f1d1a000-0000-4000-8000-000000000314",
      type: "custom-metric",
      label: "Salidas del mes",
      aggregation: "sum",
      period: "this-month",
    },
  ] as const;

  const document = Schema.decodeUnknownSync(DashboardDocument)({
    title: "Resumen",
    layout: {
      kind: "split",
      axis: "row",
      children: widgets.map((widget) => ({
        weight: 1,
        node: { kind: "leaf", widget },
      })),
    },
  });

  expect(document.layout.kind).toBe("split");
  if (document.layout.kind === "split") {
    expect(
      document.layout.children.map((child) => child.node.kind === "leaf" && child.node.widget.type)
    ).toEqual(["spending-chart", "budget-bar", "transaction-list", "custom-metric"]);
  }
  expect(collectDashboardCategoryReferences(document)).toEqual([
    {
      categoryId,
      widgetId: "f1d1a000-0000-4000-8000-000000000311",
      field: "categories.0",
    },
    {
      categoryId,
      widgetId: "f1d1a000-0000-4000-8000-000000000312",
      field: "categoryId",
    },
  ]);
});

it("accepts only deterministic, non-zero, Currency-consistent Money groups", () => {
  const valid = Schema.decodeUnknownSync(DashboardMoneyGroups)([
    {
      currency: "COP",
      inflow: { amount: "10", currency: "COP" },
      outflow: { amount: "0", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "2.5", currency: "USD" },
    },
  ]);

  expect(Schema.encodeSync(DashboardMoneyGroups)(valid)).toEqual([
    {
      currency: "COP",
      inflow: { amount: "10", currency: "COP" },
      outflow: { amount: "0", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "2.5", currency: "USD" },
    },
  ]);

  const invalidGroups = [
    [
      {
        currency: "COP",
        inflow: { amount: "1", currency: "USD" },
        outflow: { amount: "0", currency: "COP" },
      },
    ],
    [
      {
        currency: "USD",
        inflow: { amount: "1", currency: "USD" },
        outflow: { amount: "0", currency: "USD" },
      },
      {
        currency: "COP",
        inflow: { amount: "1", currency: "COP" },
        outflow: { amount: "0", currency: "COP" },
      },
    ],
    [
      {
        currency: "COP",
        inflow: { amount: "0", currency: "COP" },
        outflow: { amount: "0", currency: "COP" },
      },
    ],
  ];

  for (const groups of invalidGroups) {
    expect(Result.isFailure(Schema.decodeUnknownResult(DashboardMoneyGroups)(groups))).toBe(true);
  }
});

it("decodes currency-safe ephemeral widget results without a mixed-Currency scalar", () => {
  const shared = {
    widgetId: "f1d1a000-0000-4000-8000-000000000315",
    context: {
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
    },
    appliedPeriod: {
      from: "2026-07-01T05:00:00.000Z",
      toExclusive: "2026-08-01T05:00:00.000Z",
    },
  } as const;
  const moneyGroups = [
    {
      currency: "COP",
      inflow: { amount: "0", currency: "COP" },
      outflow: { amount: "25", currency: "COP" },
    },
  ] as const;

  const spending = Schema.decodeUnknownSync(SpendingChartData)({
    type: "spending-chart",
    ...shared,
    buckets: [
      {
        key: { kind: "category", categoryId },
        moneyGroups,
      },
    ],
  });
  const metric = Schema.decodeUnknownSync(CustomMetricData)({
    type: "custom-metric",
    ...shared,
    aggregation: "sum",
    moneyGroups,
  });
  const budget = Schema.decodeUnknownSync(BudgetBarData)({
    type: "budget-bar",
    ...shared,
    categoryId,
    currency: "COP",
    cap: { amount: "100", currency: "COP" },
    spent: { amount: "25", currency: "COP" },
    status: { state: "under", remaining: { amount: "75", currency: "COP" } },
  });

  expect(spending.buckets).toHaveLength(1);
  expect(metric.moneyGroups[0]?.currency).toBe("COP");
  expect(budget.status.state).toBe("under");
  expect(Reflect.has(Schema.encodeSync(CustomMetricData)(metric), "net")).toBe(false);
});

it("rejects invalid periods and every mixed-Currency Budget Money value", () => {
  const base = {
    type: "budget-bar",
    widgetId: "f1d1a000-0000-4000-8000-000000000316",
    context: { serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" },
    appliedPeriod: {
      from: "2026-08-01T05:00:00.000Z",
      toExclusive: "2026-07-01T05:00:00.000Z",
    },
    categoryId,
    currency: "COP",
    cap: { amount: "100", currency: "USD" },
    spent: { amount: "25", currency: "COP" },
    status: { state: "under", remaining: { amount: "75", currency: "COP" } },
  };

  expect(Result.isFailure(Schema.decodeUnknownResult(BudgetBarData)(base))).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(BudgetBarData)({
        ...base,
        appliedPeriod: {
          from: "2026-07-01T05:00:00.000Z",
          toExclusive: "2026-08-01T05:00:00.000Z",
        },
        cap: { amount: "100", currency: "COP" },
        status: { state: "over", overBy: { amount: "1", currency: "USD" } },
      })
    )
  ).toBe(true);
});

it("rejects duplicate widget identities and non-canonical same-axis nesting", () => {
  const widget = {
    id: "f1d1a000-0000-4000-8000-000000000321",
    type: "custom-metric",
    label: "Salidas",
    aggregation: "sum",
    period: "this-month",
  };
  const leaf = { kind: "leaf", widget };
  const invalidLayouts = [
    {
      kind: "split",
      axis: "row",
      children: [
        { weight: 1, node: leaf },
        { weight: 1, node: leaf },
      ],
    },
    {
      kind: "split",
      axis: "column",
      children: [
        {
          weight: 1,
          node: {
            kind: "split",
            axis: "column",
            children: [
              { weight: 1, node: leaf },
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: { ...widget, id: "f1d1a000-0000-4000-8000-000000000322" },
                },
              },
            ],
          },
        },
        {
          weight: 1,
          node: {
            kind: "leaf",
            widget: { ...widget, id: "f1d1a000-0000-4000-8000-000000000323" },
          },
        },
      ],
    },
  ];

  for (const layout of invalidLayouts) {
    const result = Schema.decodeUnknownResult(DashboardDocument)({ title: "Resumen", layout });
    expect(Result.isFailure(result)).toBe(true);
  }
});
