import { expect, it } from "@effect/vitest";
import { BigDecimal, Option, Schema } from "effect";
import { Money } from "~/core/_shared/money";
import { CategoryId } from "~/core/categories/reference";
import { Widget } from "./model";
import {
  type ProjectedRange,
  projectAggregateBudgetSpent,
  projectAggregateChart,
  projectAggregateMetric,
} from "./aggregation";

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
      id === categoryId ? Option.some({ id: categoryId, label: "Restaurants" }) : Option.none(),
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
