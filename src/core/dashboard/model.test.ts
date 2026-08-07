import { expect, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import {
  AppliedDashboardPeriod,
  BudgetBarData,
  CustomMetricData,
  DashboardCatalog,
  DashboardDocument,
  DashboardMonetaryWidgetData,
  DashboardMoneyGroups,
  DashboardTitle,
  SpendingChartData,
  SplitWeight,
  TransactionListLimit,
  WidgetId,
  collectDashboardCategoryReferences,
  collectLayoutWidgets,
  findDashboardStructureIssue,
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

it("requires one to sixteen unique Category references", () => {
  const makeDocument = (
    categories: ReadonlyArray<string>
  ): {
    title: string;
    layout: {
      kind: string;
      widget: { id: string; type: string; limit: number; categories: readonly string[] };
    };
  } => ({
    title: "Resumen",
    layout: {
      kind: "leaf",
      widget: {
        id: "f1d1a000-0000-4000-8000-000000000320",
        type: "transaction-list",
        limit: 10,
        categories,
      },
    },
  });
  const categories = Array.from(
    { length: 16 },
    (_, index) => `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`
  );

  expect(Schema.decodeUnknownSync(DashboardDocument)(makeDocument(categories))).toBeDefined();
  for (const invalid of [[], [...categories, categoryId], [categoryId, categoryId]]) {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(DashboardDocument)(makeDocument(invalid)))
    ).toBe(true);
  }
});

it("checks each Money-group branch and reports its exact Currency field", () => {
  const group = {
    currency: "COP",
    inflow: { amount: "1", currency: "COP" },
    outflow: { amount: "0", currency: "COP" },
  };
  const cases = [
    [{ ...group, inflow: { amount: "1", currency: "USD" } }, '[0]["inflow"]["currency"]'],
    [{ ...group, outflow: { amount: "0", currency: "USD" } }, '[0]["outflow"]["currency"]'],
    [{ ...group, inflow: { amount: "0", currency: "COP" } }, "non-zero Money value"],
  ] as const;

  for (const [invalid, expectedIssue] of cases) {
    const result = Schema.decodeUnknownResult(DashboardMoneyGroups)([invalid]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain(expectedIssue);
    }
  }
});

it("accepts empty and ordered Currency groups but rejects duplicate and descending neighbors", () => {
  const group = (
    currency: "COP" | "EUR" | "USD"
  ): {
    currency: "COP" | "EUR" | "USD";
    inflow: { amount: string; currency: "COP" | "EUR" | "USD" };
    outflow: { amount: string; currency: "COP" | "EUR" | "USD" };
  } => ({
    currency,
    inflow: { amount: "1", currency },
    outflow: { amount: "0", currency },
  });

  expect(Schema.decodeUnknownSync(DashboardMoneyGroups)([])).toEqual([]);
  expect(Schema.decodeUnknownSync(DashboardMoneyGroups)([group("COP")])).toHaveLength(1);
  expect(
    Schema.decodeUnknownSync(DashboardMoneyGroups)([group("COP"), group("EUR"), group("USD")])
  ).toHaveLength(3);
  for (const groups of [
    [group("COP"), group("COP")],
    [group("USD"), group("COP")],
  ]) {
    const result = Schema.decodeUnknownResult(DashboardMoneyGroups)(groups);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain('[1]["currency"]');
    }
  }
});

it("reports the first out-of-order Currency group after an ordered prefix", () => {
  const group = (
    currency: "COP" | "EUR" | "USD"
  ): {
    currency: "COP" | "EUR" | "USD";
    inflow: { amount: string; currency: "COP" | "EUR" | "USD" };
    outflow: { amount: string; currency: "COP" | "EUR" | "USD" };
  } => ({
    currency,
    inflow: { amount: "1", currency },
    outflow: { amount: "0", currency },
  });

  const result = Schema.decodeUnknownResult(DashboardMoneyGroups)([
    group("COP"),
    group("USD"),
    group("EUR"),
  ]);

  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(String(result.failure)).toContain('[2]["currency"]');
  }
});

it("checks every adjacent Currency boundary with strict order", () => {
  type MoneyGroup = Readonly<{
    readonly currency: "COP" | "EUR" | "USD";
    readonly inflow: Readonly<{
      readonly amount: string;
      readonly currency: "COP" | "EUR" | "USD";
    }>;
    readonly outflow: Readonly<{
      readonly amount: string;
      readonly currency: "COP" | "EUR" | "USD";
    }>;
  }>;
  const group = (currency: MoneyGroup["currency"]): MoneyGroup => ({
    currency,
    inflow: { amount: "1", currency },
    outflow: { amount: "0", currency },
  });
  const decode = Schema.decodeUnknownResult(DashboardMoneyGroups);

  expect(Result.isSuccess(decode([]))).toBe(true);
  expect(Result.isSuccess(decode([group("COP")]))).toBe(true);
  expect(Result.isSuccess(decode([group("COP"), group("EUR")]))).toBe(true);

  const duplicate = decode([group("COP"), group("COP")]);
  expect(Result.isFailure(duplicate)).toBe(true);
  if (Result.isFailure(duplicate)) {
    expect(String(duplicate.failure)).toContain('[1]["currency"]');
  }

  const laterDisorder = decode([group("COP"), group("USD"), group("EUR")]);
  expect(Result.isFailure(laterDisorder)).toBe(true);
  if (Result.isFailure(laterDisorder)) {
    expect(String(laterDisorder.failure)).toContain('[2]["currency"]');
  }
});

it("requires an applied period to end strictly after it starts", () => {
  const from = "2026-07-01T05:00:00.000Z";

  expect(
    Schema.decodeUnknownSync(AppliedDashboardPeriod)({
      from,
      toExclusive: "2026-07-01T05:00:00.001Z",
    })
  ).toBeDefined();
  for (const toExclusive of [from, "2026-07-01T04:59:59.999Z"]) {
    const result = Schema.decodeUnknownResult(AppliedDashboardPeriod)({ from, toExclusive });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain('["toExclusive"]');
    }
  }
});

it("accepts only exact local calendar day and month bucket keys", () => {
  const shared = {
    type: "spending-chart",
    widgetId: "f1d1a000-0000-4000-8000-000000000319",
    context: { serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" },
    appliedPeriod: {
      from: "2026-07-01T05:00:00.000Z",
      toExclusive: "2026-08-01T05:00:00.000Z",
    },
  };
  const decodeKey = (key: unknown): Result.Result<SpendingChartData, Schema.SchemaError> =>
    Schema.decodeUnknownResult(SpendingChartData)({
      ...shared,
      buckets: [{ key, moneyGroups: [] }],
    });

  for (const key of [
    { kind: "day", date: "2026-01-01" },
    { kind: "day", date: "2026-12-31" },
    { kind: "month", month: "2026-01" },
    { kind: "month", month: "2026-12" },
  ]) {
    expect(Result.isSuccess(decodeKey(key))).toBe(true);
  }
  for (const date of [
    "x2026-01-01",
    "2026-01-01x",
    "026-01-01",
    "2x26-01-01",
    "2026-00-01",
    "2026-13-01",
    "2026-x1-01",
    "2026-01-00",
    "2026-01-32",
    "2026-01-x1",
    "2026-01-1x",
    "2026-01-3x",
  ]) {
    expect(Result.isFailure(decodeKey({ kind: "day", date }))).toBe(true);
  }
  for (const month of [
    "x2026-01",
    "2026-01x",
    "026-01",
    "2x26-01",
    "2026-00",
    "2026-13",
    "2026-x1",
    "2026-1x",
  ]) {
    expect(Result.isFailure(decodeKey({ kind: "month", month }))).toBe(true);
  }
});

it("checks every Budget Money branch and preserves the failing field path", () => {
  const valid = {
    type: "budget-bar",
    widgetId: "f1d1a000-0000-4000-8000-000000000318",
    context: { serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" },
    appliedPeriod: {
      from: "2026-07-01T05:00:00.000Z",
      toExclusive: "2026-08-01T05:00:00.000Z",
    },
    categoryId,
    currency: "COP",
    cap: { amount: "100", currency: "COP" },
    spent: { amount: "25", currency: "COP" },
    status: { state: "reached" },
  } as const;
  const cases = [
    [{ ...valid, cap: { amount: "100", currency: "USD" } }, '["cap"]["currency"]'],
    [{ ...valid, spent: { amount: "25", currency: "USD" } }, '["spent"]["currency"]'],
    [
      { ...valid, status: { state: "under", remaining: { amount: "75", currency: "USD" } } },
      '["status"]["remaining"]["currency"]',
    ],
    [
      { ...valid, status: { state: "over", overBy: { amount: "1", currency: "USD" } } },
      '["status"]["overBy"]["currency"]',
    ],
  ] as const;

  expect(Result.isSuccess(Schema.decodeUnknownResult(BudgetBarData)(valid))).toBe(true);
  for (const [invalid, path] of cases) {
    const result = Schema.decodeUnknownResult(BudgetBarData)(invalid);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain(path);
    }
  }
  for (const status of [
    { state: "under", remaining: { amount: "75", currency: "COP" } },
    { state: "over", overBy: { amount: "1", currency: "COP" } },
  ]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(BudgetBarData)({ ...valid, status }))).toBe(
      true
    );
  }
});

it("decodes each monetary result through the shared closed result schema", () => {
  const shared = {
    widgetId: "f1d1a000-0000-4000-8000-000000000317",
    context: { serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" },
    appliedPeriod: {
      from: "2026-07-01T05:00:00.000Z",
      toExclusive: "2026-08-01T05:00:00.000Z",
    },
  };
  const results = [
    { type: "spending-chart", ...shared, buckets: [] },
    {
      type: "budget-bar",
      ...shared,
      categoryId,
      currency: "COP",
      cap: { amount: "100", currency: "COP" },
      spent: { amount: "100", currency: "COP" },
      status: { state: "reached" },
    },
    { type: "custom-metric", ...shared, aggregation: "average", moneyGroups: [] },
  ];

  for (const result of results) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(DashboardMonetaryWidgetData)(result))).toBe(
      true
    );
  }
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(DashboardMonetaryWidgetData)({ type: "transaction-list" })
    )
  ).toBe(true);
});

it("requires every split to contain at least two child regions", () => {
  const oneChild = {
    title: "Resumen",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: 1,
          node: {
            kind: "leaf",
            widget: transactionWidget("f1d1a000-0000-4000-8000-000000000327"),
          },
        },
      ],
    },
  };

  expect(Result.isFailure(Schema.decodeUnknownResult(DashboardDocument)(oneChild))).toBe(true);
});

it("requires exactly four catalog entries", () => {
  expect(Result.isFailure(Schema.decodeUnknownResult(DashboardCatalog)([]))).toBe(true);
});

it("collects every leaf in recursive mobile order", () => {
  const decoded = Schema.decodeUnknownSync(DashboardDocument)({
    title: "Resumen",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: 1,
          node: {
            kind: "leaf",
            widget: {
              id: "f1d1a000-0000-4000-8000-000000000324",
              type: "transaction-list",
              limit: 10,
            },
          },
        },
        {
          weight: 1,
          node: {
            kind: "split",
            axis: "column",
            children: [
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: {
                    id: "f1d1a000-0000-4000-8000-000000000325",
                    type: "custom-metric",
                    label: "Uno",
                    aggregation: "sum",
                    period: "this-month",
                  },
                },
              },
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: {
                    id: "f1d1a000-0000-4000-8000-000000000326",
                    type: "transaction-list",
                    limit: 10,
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });

  expect(collectLayoutWidgets(decoded.layout).map(({ id }) => id)).toEqual([
    "f1d1a000-0000-4000-8000-000000000324",
    "f1d1a000-0000-4000-8000-000000000325",
    "f1d1a000-0000-4000-8000-000000000326",
  ]);
});

type RawTransactionWidget = Readonly<{
  id: string;
  type: "transaction-list";
  limit: number;
}>;
type RawLayout =
  | Readonly<{ kind: "leaf"; widget: RawTransactionWidget }>
  | Readonly<{
      kind: "split";
      axis: "row" | "column";
      children: readonly [RawChild, RawChild, ...ReadonlyArray<RawChild>];
    }>;
type RawChild = Readonly<{ weight: number; node: RawLayout }>;

const transactionWidget = (id: string): RawTransactionWidget => ({
  id,
  type: "transaction-list",
  limit: 10,
});

it("enforces the layout depth boundary and retains the first traversal issue", () => {
  let nextId = 330;
  const leaf = (id = nextId++): RawLayout => ({
    kind: "leaf",
    widget: transactionWidget(`f1d1a000-0000-4000-8000-${id.toString().padStart(12, "0")}`),
  });
  const nested = (splitCount: number): RawLayout => {
    let node = leaf();
    for (let depth = 0; depth < splitCount; depth += 1) {
      node = {
        kind: "split",
        axis: depth % 2 === 0 ? "row" : "column",
        children: [
          { weight: 1, node: leaf() },
          { weight: 1, node },
        ],
      };
    }
    return node;
  };
  const valid = Schema.decodeUnknownSync(DashboardDocument)({
    title: "Resumen",
    layout: nested(8),
  });
  const tooDeep = Schema.decodeUnknownResult(DashboardDocument)({
    title: "Resumen",
    layout: nested(9),
  });

  expect(Option.isNone(findDashboardStructureIssue(valid))).toBe(true);
  expect(Result.isFailure(tooDeep) ? String(tooDeep.failure) : "").toContain(
    "DashboardDocument layout depth must not exceed 8"
  );

  const duplicate = leaf(399);
  const firstIssue = Schema.decodeUnknownResult(DashboardDocument)({
    title: "Resumen",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        { weight: 1, node: duplicate },
        {
          weight: 1,
          node: {
            kind: "split",
            axis: "column",
            children: [
              { weight: 1, node: duplicate },
              { weight: 1, node: nested(9) },
            ],
          },
        },
      ],
    },
  });
  expect(Result.isFailure(firstIssue) ? String(firstIssue.failure) : "").toContain(
    "Expected a unique WidgetId in DashboardDocument"
  );
});

it("reports the exact nested WidgetId path for a duplicate identity", () => {
  const duplicateId = WidgetId.make("f1d1a000-0000-4000-8000-000000000398");
  const widget = {
    id: duplicateId,
    type: "transaction-list" as const,
    limit: TransactionListLimit.make(10),
  };

  const issue = findDashboardStructureIssue({
    title: DashboardTitle.make("Resumen"),
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: SplitWeight.make(1),
          node: { kind: "leaf", widget },
        },
        {
          weight: SplitWeight.make(1),
          node: { kind: "leaf", widget },
        },
      ],
    },
  });

  expect(issue).toEqual(
    Option.some({
      path: ["layout", "children", 1, "node", "widget", "id"],
      issue: "Expected a unique WidgetId in DashboardDocument",
    })
  );
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

  const expectedIssues = [
    "Expected a unique WidgetId in DashboardDocument",
    "Expected canonical layout without nested splits on the same axis",
  ];
  for (const [index, layout] of invalidLayouts.entries()) {
    const result = Schema.decodeUnknownResult(DashboardDocument)({ title: "Resumen", layout });
    expect(Result.isFailure(result) ? String(result.failure) : "").toContain(expectedIssues[index]);
  }
});
