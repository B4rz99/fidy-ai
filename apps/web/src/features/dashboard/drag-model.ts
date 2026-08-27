import { Option } from "effect";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import type { DashboardGesture } from "./editor-model";

type WidgetId = Extract<DashboardGesture, { readonly kind: "move-widget" }>["widgetId"];

type ResolveDropInput = Readonly<{
  canceled: boolean;
  source: Option.Option<DashboardDragSource>;
  target: Option.Option<DashboardDropTarget>;
  makeWidgetId: () => WidgetId;
}>;

const isOwnEdge = (source: DashboardDragSource, target: DashboardDropTarget): boolean =>
  source.kind === "widget" && target.kind === "widget-edge" && source.widgetId === target.widgetId;

const existingWidgetGesture = (
  source: Extract<DashboardDragSource, { readonly kind: "widget" }>,
  target: DashboardDropTarget
): DashboardGesture =>
  target.kind === "widget-edge" && target.edge === "center"
    ? { kind: "swap-widgets", widgetId: source.widgetId, withWidgetId: target.widgetId }
    : { kind: "move-widget", widgetId: source.widgetId, target };

/** Translates a completed library interaction into at most one application gesture. */
export const resolveDashboardDrop = ({
  canceled,
  makeWidgetId,
  source,
  target,
}: ResolveDropInput): Option.Option<DashboardGesture> => {
  if (
    canceled ||
    Option.isNone(source) ||
    Option.isNone(target) ||
    isOwnEdge(source.value, target.value)
  ) {
    return Option.none();
  }
  const decodedSource = source.value;
  const decodedTarget = target.value;
  return Option.some(
    decodedSource.kind === "widget"
      ? existingWidgetGesture(decodedSource, decodedTarget)
      : {
          kind: "add-catalog-widget",
          entry: decodedSource.entry,
          newWidgetId: makeWidgetId(),
          target: decodedTarget,
        }
  );
};
