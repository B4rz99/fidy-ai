import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { WidgetId } from "@/transport/client";
import type { CanonicalInput } from "@/transport/client";
import {
  type DashboardCatalogEntry,
  type DashboardGesture,
  compileDashboardGesture,
} from "./editor-model";

const firstId = WidgetId.make("f1d1a000-0000-4000-8000-000000000801");
const secondId = WidgetId.make("f1d1a000-0000-4000-8000-000000000802");
const thirdId = WidgetId.make("f1d1a000-0000-4000-8000-000000000803");

const catalogEntry = {
  id: "monthly-spending",
  name: "Gastos mensuales",
  description: "Gastos del mes por categoría.",
  widget: {
    type: "spending-chart",
    groupBy: "category",
    period: "this-month",
  },
} satisfies DashboardCatalogEntry;

const compile = (
  gesture: DashboardGesture
): CanonicalInput<"dashboard.applyDashboardEdit">["payload"] => {
  const result = compileDashboardGesture(gesture);
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

describe("Dashboard gesture compilation", () => {
  it("compiles a center drop into one canonical swap edit", () => {
    expect(compile({ kind: "swap-widgets", widgetId: firstId, withWidgetId: secondId })).toEqual({
      op: "swap-widgets",
      widgetId: firstId,
      withWidgetId: secondId,
    });
  });

  it("compiles each directional drop into one structural move edit", () => {
    const placements = [
      ["left", { besideWidget: secondId, axis: "row", side: "before" }],
      ["right", { besideWidget: secondId, axis: "row", side: "after" }],
      ["top", { besideWidget: secondId, axis: "column", side: "before" }],
      ["bottom", { besideWidget: secondId, axis: "column", side: "after" }],
      ["center", { besideWidget: secondId, axis: "row", side: "after" }],
    ] as const;
    for (const [edge, at] of placements) {
      expect(
        compile({
          kind: "move-widget",
          widgetId: firstId,
          target: { kind: "widget-edge", widgetId: secondId, edge },
        })
      ).toEqual({ op: "move-widget", widgetId: firstId, at });
    }
  });

  it("adds a catalog preset with browser-generated identity through the same placement", () => {
    expect(
      compile({
        kind: "add-catalog-widget",
        entry: catalogEntry,
        newWidgetId: thirdId,
        target: { kind: "dashboard-edge", edge: "top" },
      })
    ).toEqual({
      op: "add-widget",
      widget: { id: thirdId, type: "spending-chart", groupBy: "category", period: "this-month" },
      at: "top",
    });
  });

  it("removes one Widget through the canonical edit", () => {
    expect(compile({ kind: "remove-widget", widgetId: firstId })).toEqual({
      op: "remove-widget",
      widgetId: firstId,
    });
  });

  it("retitles one Widget through its canonical replacement edit", () => {
    const widget = { ...catalogEntry.widget, id: firstId };
    expect(compile({ kind: "retitle-widget", title: "Resumen mensual", widget })).toEqual({
      op: "update-widget",
      widget: { ...widget, title: "Resumen mensual" },
    });
  });

  it("compiles a continuous compound-region weight", () => {
    expect(
      compile({
        kind: "resize-region",
        widgetIds: [firstId, secondId],
        weight: 1.375,
      })
    ).toEqual({
      op: "resize-region",
      widgetIds: [firstId, secondId],
      size: { kind: "weight", weight: 1.375 },
    });
  });
});
