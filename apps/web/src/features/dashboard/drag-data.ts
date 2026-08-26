import { Schema } from "effect";
import { DashboardCatalogEntry, WidgetId } from "@/transport/client";

export const DashboardDragSourceData = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("widget"), widgetId: WidgetId, label: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("catalog"),
    entry: DashboardCatalogEntry,
  }),
]);
export type DashboardDragSource = typeof DashboardDragSourceData.Type;

export const DashboardDropTargetData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dashboard-edge"),
    edge: Schema.Literals(["top", "bottom"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("widget-edge"),
    widgetId: WidgetId,
    edge: Schema.Literals(["top", "right", "bottom", "left"]),
  }),
]);
export type DashboardDropTarget = typeof DashboardDropTargetData.Type;

/** Schema decoders for dnd-kit's untrusted source and target transport data. */
export const dashboardDragData = {
  decodeSource: Schema.decodeUnknownOption(DashboardDragSourceData),
  decodeTarget: Schema.decodeUnknownOption(DashboardDropTargetData),
} as const;
