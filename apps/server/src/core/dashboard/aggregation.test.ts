import { type DashboardBucket, type ProjectedRange, Widget } from "./contract";
import { expect, it } from "@effect/vitest";
import { BigDecimal, Option, Schema } from "effect";
import { Money, type ReadonlyMoneyGroup } from "~/core/_shared/money";
import { Category, CategoryId } from "~/core/categories/contract";

import {
  projectAggregateBudgetSpent,
  projectAggregateChart,
  projectAggregateMetric,
} from "./operations";

const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000001");
const otherId = CategoryId.make("10000000-0000-4000-8000-000000000002");
const cop = (amount: string): Money =>
  Money.make({ currency: "COP", amount: BigDecimal.make(BigInt(amount), 0) });
const usd = (amount: string): Money =>
  Money.make({ currency: "USD", amount: BigDecimal.make(BigInt(amount), 0) });
const ranges: ReadonlyArray<ProjectedRange> = [
  {
    key: "2026-07-01",
    contributions: [
      { categoryId, direction: "outflow", sum: cop("10"), maximum: cop("8"), count: 2n },
      { categoryId, direction: "outflow", sum: cop("4"), maximum: cop("4"), count: 1n },
      { categoryId: otherId, direction: "outflow", sum: cop("90"), maximum: cop("90"), count: 1n },
      { categoryId, direction: "outflow", sum: usd("3"), maximum: usd("3"), count: 1n },
    ],
  },
];
const widgetId = "30000000-0000-4000-8000-000000000001";

it("groups maintained bucket amounts and maxima by Category without mixing Currency", () => {
  const widget = Schema.decodeSync(Widget)({
    id: widgetId,
    type: "spending-chart",
    groupBy: "category",
    period: "this-month",
    categories: [categoryId],
  });
  if (widget.type !== "spending-chart") throw new Error("Expected chart");
  const result = projectAggregateChart({
    widget,
    ranges,
    lookupCategory: (id) =>
      id === categoryId
        ? Option.some(Schema.decodeSync(Category)({ id: categoryId, label: "Restaurantes" }))
        : Option.none(),
  });
  expect(Option.isSome(result)).toBe(true);
  if (Option.isNone(result)) throw new Error("Expected chart buckets");
  const grouped: Array<ReadonlyArray<unknown>> = [];
  for (const bucket of result.value) {
    const amounts: Array<ReadonlyArray<string>> = [];
    for (const group of bucket.moneyGroups) {
      amounts.push([group.currency, BigDecimal.format(group.outflow.amount)]);
    }
    grouped.push([bucket.key.kind, ...amounts]);
  }
  expect(grouped).toEqual([["category", ["COP", "14"], ["USD", "3"]]]);
  expect(projectAggregateChart({ widget, ranges, lookupCategory: () => Option.none() })._tag).toBe(
    "None"
  );
});

it("finalizes exact sum, maximum, and weighted average from projected contributions", () => {
  const metric = Schema.decodeSync(Widget)({
    id: widgetId,
    type: "custom-metric",
    label: "Spending",
    aggregation: "sum",
    period: "this-month",
    categories: [categoryId],
  });
  if (metric.type !== "custom-metric") throw new Error("Expected metric");
  const amounts = (
    aggregation: "sum" | "maximum" | "average"
  ): ReadonlyArray<readonly [string, string]> => {
    const result: Array<readonly [string, string]> = [];
    for (const group of projectAggregateMetric({ ...metric, aggregation }, ranges)) {
      result.push([group.currency, BigDecimal.format(group.outflow.amount)]);
    }
    return result;
  };
  expect(amounts("sum")).toEqual([
    ["COP", "14"],
    ["USD", "3"],
  ]);
  expect(amounts("maximum")).toEqual([
    ["COP", "8"],
    ["USD", "3"],
  ]);
  expect(amounts("average")).toEqual([
    ["COP", "4.67"],
    ["USD", "3"],
  ]);
  const budget = Schema.decodeSync(Widget)({
    id: widgetId,
    type: "budget-bar",
    categoryId,
    currency: "COP",
  });
  if (budget.type !== "budget-bar") throw new Error("Expected budget");
  expect(BigDecimal.format(projectAggregateBudgetSpent(budget, ranges).amount)).toBe("14");
});

it("projects day and month chart buckets and omits empty ranges", () => {
  for (const groupBy of ["day", "month"] as const) {
    const widget = Schema.decodeSync(Widget)({
      id: widgetId,
      type: "spending-chart",
      groupBy,
      period: "this-month",
      categories: [categoryId],
    });
    if (widget.type !== "spending-chart") throw new Error("Expected chart");
    const key = groupBy === "day" ? "2026-07-01" : "2026-07";
    const buckets = Option.getOrThrow(
      projectAggregateChart({
        widget,
        ranges: [
          { ...ranges[0], key, contributions: ranges[0]?.contributions ?? [] },
          { key: "unused", contributions: [] },
        ],
        lookupCategory: () => Option.none(),
      })
    );
    expect(
      buckets.map(
        (
          bucket: Readonly<{ key: DashboardBucket; moneyGroups: ReadonlyArray<ReadonlyMoneyGroup> }>
        ) => ({
          key: bucket.key,
          groups: bucket.moneyGroups.map((group) => [
            group.currency,
            BigDecimal.format(group.outflow.amount),
          ]),
        })
      )
    ).toEqual([
      {
        key: groupBy === "day" ? { kind: "day", date: key } : { kind: "month", month: key },
        groups: [
          ["COP", "14"],
          ["USD", "3"],
        ],
      },
    ]);
  }
});

it("orders unfiltered category buckets by stable identity regardless of projection insertion order", () => {
  const widget = Schema.decodeSync(Widget)({
    id: widgetId,
    type: "spending-chart",
    groupBy: "category",
    period: "this-month",
  });
  if (widget.type !== "spending-chart") throw new Error("Expected chart");
  const buckets = Option.getOrThrow(
    projectAggregateChart({
      widget,
      ranges: [
        {
          key: "2026-07-01",
          contributions: [
            {
              categoryId: otherId,
              direction: "outflow",
              sum: cop("90"),
              maximum: cop("90"),
              count: 1n,
            },
            { categoryId, direction: "outflow", sum: cop("10"), maximum: cop("10"), count: 1n },
          ],
        },
      ],
      lookupCategory: (id) => Option.some(Schema.decodeSync(Category)({ id, label: "Categoría" })),
    })
  );
  expect(
    buckets.map((bucket: Readonly<{ key: DashboardBucket }>) =>
      bucket.key.kind === "category" ? bucket.key.category.id : "unexpected"
    )
  ).toEqual([categoryId, otherId]);
});
