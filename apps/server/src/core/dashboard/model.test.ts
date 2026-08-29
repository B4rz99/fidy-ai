import { expect, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import {
  AppliedDashboardPeriod,
  DashboardCatalog,
  DashboardDocument,
  DashboardTitle,
  SplitWeight,
  TransactionListLimit,
  WidgetId,
  collectDashboardCategoryReferences,
  collectLayoutWidgets,
  findDashboardStructureIssue,
} from "./model";

const categoryId = "10000000-0000-4000-8000-000000000001";

it("decodes the one User dashboard without storage identity or format fields", () => {
  const document = Schema.decodeSync(DashboardDocument)({
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

it("requires an applied period to end strictly after it starts", () => {
  const from = "2026-07-01T05:00:00.000Z";
  const shared = { requested: "this-month", timeZone: "America/Bogota", from };

  expect(
    Schema.decodeUnknownSync(AppliedDashboardPeriod)({
      ...shared,
      toExclusive: "2026-07-01T05:00:00.001Z",
    })
  ).toBeDefined();
  for (const toExclusive of [from, "2026-07-01T04:59:59.999Z"]) {
    const result = Schema.decodeUnknownResult(AppliedDashboardPeriod)({
      ...shared,
      toExclusive,
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain('["toExclusive"]');
    }
  }
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
  const decoded = Schema.decodeSync(DashboardDocument)({
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
  const valid = Schema.decodeSync(DashboardDocument)({
    title: "Resumen",
    layout: nested(8),
  });
  const tooDeep = Schema.decodeResult(DashboardDocument)({
    title: "Resumen",
    layout: nested(9),
  });

  expect(Option.isNone(findDashboardStructureIssue(valid))).toBe(true);
  expect(Result.isFailure(tooDeep) ? String(tooDeep.failure) : "").toContain(
    "DashboardDocument layout depth must not exceed 8"
  );

  const duplicate = leaf(399);
  const firstIssue = Schema.decodeResult(DashboardDocument)({
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
