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
  return Option.some(
    source.value.kind === "widget"
      ? { kind: "move-widget", widgetId: source.value.widgetId, target: target.value }
      : {
          kind: "add-catalog-widget",
          entry: source.value.entry,
          newWidgetId: makeWidgetId(),
          target: target.value,
        }
  );
};
