import { BigDecimal } from "effect";
import { dashboardCategoryVisual } from "@/ui/components/dashboard-category";
import { moneyDecimalText, moneySeriesGeometry } from "./money-presentation";
import type { DashboardWidgetView } from "./presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;

const bucketLabel = (key: SpendingResult["buckets"][number]["key"]): string => {
  switch (key.kind) {
    case "category":
      return key.category.label;
    case "day":
      return key.date;
    case "month":
      return key.month;
  }
};

const presentBucket = (
  key: SpendingResult["buckets"][number]["key"]
): Readonly<{ key: string; label: string; fill: string }> => {
  const label = bucketLabel(key);
  return key.kind === "category"
    ? { key: key.category.id, label, fill: dashboardCategoryVisual(key.category.id).fill }
    : { key: label, label, fill: "var(--dashboard-chart-fill)" };
};

export type CurrencyChartDatum = Readonly<{
  key: string;
  label: string;
  fill: string;
  outflowExact: string;
  outflow: number;
}>;

export const currencyChartData = ({
  data,
  currency,
}: Readonly<{ data: SpendingResult; currency: string }>): ReadonlyArray<CurrencyChartDatum> => {
  const zero = BigDecimal.make(0n, 0);
  const values = data.buckets.flatMap((bucket) => {
    const group = bucket.moneyGroups.find((candidate) => candidate.currency === currency);
    if (
      bucket.key.kind === "category" &&
      (group === undefined || !BigDecimal.isPositive(group.outflow.amount))
    ) {
      return [];
    }
    return [
      {
        ...presentBucket(bucket.key),
        outflowExact: group === undefined ? "0" : moneyDecimalText(group.outflow),
        outflowAmount: group?.outflow.amount ?? zero,
      },
    ];
  });
  const geometry = moneySeriesGeometry(values.map(({ outflowAmount }) => outflowAmount));
  return values.map(({ outflowAmount: _outflow, ...value }, index) => ({
    ...value,
    outflow: geometry[index] ?? 0,
  }));
};
