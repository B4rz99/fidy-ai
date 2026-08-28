import { Schema } from "effect";
import { DashboardCatalogEntry, WidgetId } from "@/transport/client";

/** Untrusted dnd-kit payload for an existing Widget or catalog source. */
export const DashboardDragSourceData = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("widget"), widgetId: WidgetId, label: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("catalog"),
    entry: DashboardCatalogEntry,
  }),
]);
/** Decoded source identity accepted by the Dashboard drag adapter. */
export type DashboardDragSource = typeof DashboardDragSourceData.Type;

/** Untrusted dnd-kit payload for one semantic Dashboard placement outcome. */
export const DashboardDropTargetData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dashboard-edge"),
    edge: Schema.Literals(["top", "bottom"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("widget-edge"),
    widgetId: WidgetId,
    edge: Schema.Literals(["top", "right", "bottom", "left", "center"]),
  }),
]);
/** Decoded placement destination accepted by the Dashboard drag adapter. */
export type DashboardDropTarget = typeof DashboardDropTargetData.Type;

/** Schema decoders for dnd-kit's untrusted source and target transport data. */
export const dashboardDragData = {
  decodeSource: Schema.decodeUnknownOption(DashboardDragSourceData),
  decodeTarget: Schema.decodeUnknownOption(DashboardDropTargetData),
} as const;
