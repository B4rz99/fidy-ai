import { Result, Schema } from "effect";
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
const TransactionListLimit = Schema.Int.pipe(Schema.brand("TransactionListLimit"));

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
  it("compiles each directional drop into one structural move edit", () => {
    expect(
      compile({
        kind: "move-widget",
        widgetId: firstId,
        target: { kind: "widget-edge", widgetId: secondId, edge: "left" },
      })
    ).toEqual({
      op: "move-widget",
      widgetId: firstId,
      at: { besideWidget: secondId, axis: "row", side: "before" },
    });
    expect(
      compile({
        kind: "move-widget",
        widgetId: firstId,
        target: { kind: "widget-edge", widgetId: secondId, edge: "bottom" },
      })
    ).toEqual({
      op: "move-widget",
      widgetId: firstId,
      at: { besideWidget: secondId, axis: "column", side: "after" },
    });
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

  it("compiles an exact compound-region ratio", () => {
    expect(
      compile({
        kind: "resize-region",
        widgetIds: [firstId, secondId],
        ratio: "three-quarters",
      })
    ).toEqual({
      op: "resize-region",
      widgetIds: [firstId, secondId],
      size: { kind: "ratio", ratio: "three-quarters" },
    });
  });

  it("compiles Dashboard and Widget titles without partial Widget replacement", () => {
    expect(compile({ kind: "retitle-dashboard", title: "Flujo de caja" })).toEqual({
      op: "set-title",
      title: "Flujo de caja",
    });
    expect(
      compile({
        kind: "retitle-widget",
        widget: {
          id: firstId,
          type: "transaction-list",
          limit: TransactionListLimit.make(10),
        },
        title: "Últimos movimientos",
      })
    ).toEqual({
      op: "update-widget",
      widget: {
        id: firstId,
        type: "transaction-list",
        limit: 10,
        title: "Últimos movimientos",
      },
    });
  });

  it("rejects malformed title input before transport", () => {
    expect(
      Result.isFailure(compileDashboardGesture({ kind: "retitle-dashboard", title: " padded " }))
    ).toBe(true);
  });
});
