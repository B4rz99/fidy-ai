import { Schema } from "effect";
import { DashboardDocument, type DashboardPeriod } from "../src/core/dashboard/contract";

const widgetKinds = 4;
const maximumWidgets = 24;
const uuidWidth = 12;
const chartGroupings = ["category", "day", "month"] as const;
const aggregations = ["sum", "average", "maximum"] as const;
const periods: ReadonlyArray<DashboardPeriod> = [
  "this-month",
  "last-7-days",
  "this-week",
  "last-month",
  "last-30-days",
  "last-week",
];
const categoryId = "10000000-0000-4000-8000-000000000001";
const widget = (ordinal: number): unknown => {
  const id = `89000000-0000-4000-8000-${String(ordinal).padStart(uuidWidth, "0")}`;
  const group = Math.floor(ordinal / widgetKinds);
  const period = periods[group];
  switch (ordinal % widgetKinds) {
    case 0:
      return {
        id,
        type: "spending-chart",
        period,
        groupBy: chartGroupings[group % chartGroupings.length],
      };
    case 1:
      return { id, type: "budget-bar", categoryId, currency: "COP" };
    case 2:
      return {
        id,
        type: "transaction-list",
        limit: 50,
        ...(group % 2 === 0 ? {} : { categories: [categoryId], search: "Evaluación" }),
      };
    default:
      return {
        id,
        type: "custom-metric",
        period,
        label: `Métrica ${group}`,
        aggregation: aggregations[group % aggregations.length],
      };
  }
};

export const maximumAssessmentDashboard = (): DashboardDocument =>
  Schema.decodeUnknownSync(DashboardDocument)({
    title: "Tablero",
    layout: {
      kind: "split",
      axis: "column",
      children: Array.from({ length: maximumWidgets }, (_, ordinal) => ({
        weight: 1,
        node: { kind: "leaf", widget: widget(ordinal) },
      })),
    },
  });
