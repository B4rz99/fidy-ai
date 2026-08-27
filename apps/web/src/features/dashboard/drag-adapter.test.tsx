import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WidgetId } from "@/transport/client";
import { dashboardAnnouncementText, dashboardCollisionPriority } from "./drag-accessibility";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import type { DashboardCatalogEntry } from "./editor-model";
import { dashboardTargetAcceptsSource, resolveDashboardDrop } from "./drag-model";

const sourceId = Schema.decodeUnknownSync(WidgetId)("f1d1a000-0000-4000-8000-000000000801");
const targetId = Schema.decodeUnknownSync(WidgetId)("f1d1a000-0000-4000-8000-000000000802");
const newId = Schema.decodeUnknownSync(WidgetId)("f1d1a000-0000-4000-8000-000000000803");
const TransactionListLimit = Schema.Int.pipe(Schema.brand("TransactionListLimit"));
const transactionListLimit = 10;
const entry = {
  id: "recent-transactions",
  name: "Transacciones recientes",
  description: "Muestra las transacciones más recientes.",
  widget: {
    type: "transaction-list",
    title: "Recientes",
    limit: Schema.decodeUnknownSync(TransactionListLimit)(transactionListLimit),
  },
} satisfies DashboardCatalogEntry;

describe("Dashboard drag accessibility and collision ordering", () => {
  it("gives deeper recursive targets greater collision priority", () => {
    expect(dashboardCollisionPriority(3)).toBeGreaterThan(dashboardCollisionPriority(2));
  });

  it("announces keyboard drag lifecycle in localized semantic terms", () => {
    const source = { data: { kind: "widget", widgetId: sourceId, label: "Gastos" } };
    const target = { kind: "widget-edge", widgetId: targetId, edge: "center" };
    expect(dashboardAnnouncementText.started(source.data)).toEqual(Option.some("Moviendo Gastos."));
    expect(
      dashboardAnnouncementText.over(source.data, target, Option.some("Colocar sobre Presupuesto"))
    ).toEqual(Option.some("Gastos. Colocar sobre Presupuesto."));
    expect(
      dashboardAnnouncementText.ended({
        canceled: true,
        sourceData: source.data,
        targetAriaLabel: Option.none(),
        targetData: target,
      })
    ).toEqual(Option.some("Movimiento de Gastos cancelado."));
  });
});

describe("Dashboard drag transport data", () => {
  it("rejects incomplete or malformed dnd-kit transport data", () => {
    expect(dashboardDragData.decodeSource({ kind: "widget", widgetId: "not-a-widget-id" })).toEqual(
      Option.none()
    );
    expect(
      dashboardDragData.decodeTarget({
        kind: "widget-edge",
        widgetId: targetId,
        edge: "diagonal",
      })
    ).toEqual(Option.none());
    expect(
      dashboardDragData.decodeSource({ kind: "widget", widgetId: sourceId, label: "Gastos" })
    ).toEqual(Option.some({ kind: "widget", widgetId: sourceId, label: "Gastos" }));
    expect(dashboardDragData.decodeSource({ kind: "catalog", entry })).toEqual(
      Option.some({ kind: "catalog", entry })
    );
  });
});

describe("Dashboard drag acceptance", () => {
  it("rejects a Widget's own destinations and accepts another Widget", () => {
    const source = Option.some({ kind: "widget" as const, widgetId: sourceId, label: "Gastos" });
    expect(
      dashboardTargetAcceptsSource({
        source,
        target: { kind: "widget-edge", widgetId: sourceId, edge: "right" },
      })
    ).toBe(false);
    expect(
      dashboardTargetAcceptsSource({
        source,
        target: { kind: "widget-edge", widgetId: targetId, edge: "center" },
      })
    ).toBe(true);
  });
});

describe("Dashboard drag adapter", () => {
  it("translates one existing Widget drop into one closed move gesture", () => {
    expect(
      resolveDashboardDrop({
        canceled: false,
        makeWidgetId: () => newId,
        source: Option.some({ kind: "widget", widgetId: sourceId, label: "Gastos" }),
        target: Option.some({ kind: "widget-edge", widgetId: targetId, edge: "right" }),
      })
    ).toEqual(
      Option.some({
        kind: "move-widget",
        widgetId: sourceId,
        target: { kind: "widget-edge", widgetId: targetId, edge: "right" },
      })
    );
  });

  it("translates a center drop into one closed swap gesture", () => {
    expect(
      resolveDashboardDrop({
        canceled: false,
        makeWidgetId: () => newId,
        source: Option.some({ kind: "widget", widgetId: sourceId, label: "Gastos" }),
        target: Option.some({ kind: "widget-edge", widgetId: targetId, edge: "center" }),
      })
    ).toEqual(Option.some({ kind: "swap-widgets", widgetId: sourceId, withWidgetId: targetId }));
  });

  it("ignores cancellation, a missing target, and a Widget's own edge", () => {
    const source: Option.Option<DashboardDragSource> = Option.some({
      kind: "widget",
      widgetId: sourceId,
      label: "Gastos",
    });
    const target: Option.Option<DashboardDropTarget> = Option.some({
      kind: "widget-edge",
      widgetId: sourceId,
      edge: "left",
    });
    expect(
      resolveDashboardDrop({ canceled: true, makeWidgetId: () => newId, source, target })
    ).toEqual(Option.none());
    expect(
      resolveDashboardDrop({
        canceled: false,
        makeWidgetId: () => newId,
        source,
        target: Option.none(),
      })
    ).toEqual(Option.none());
    expect(
      resolveDashboardDrop({ canceled: false, makeWidgetId: () => newId, source, target })
    ).toEqual(Option.none());
  });
});

describe("Dashboard catalog drag adapter", () => {
  it("assigns fresh identity when a catalog Widget is successfully dropped", () => {
    expect(
      resolveDashboardDrop({
        canceled: false,
        makeWidgetId: () => newId,
        source: Option.some({ kind: "catalog", entry }),
        target: Option.some({ kind: "dashboard-edge", edge: "bottom" }),
      })
    ).toEqual(
      Option.some({
        kind: "add-catalog-widget",
        entry,
        newWidgetId: newId,
        target: { kind: "dashboard-edge", edge: "bottom" },
      })
    );
  });
});
