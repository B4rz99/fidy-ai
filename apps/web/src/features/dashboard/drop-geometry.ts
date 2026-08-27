import type { DashboardDropTarget } from "./drag-data";

type WidgetEdge = Extract<DashboardDropTarget, { readonly kind: "widget-edge" }>["edge"];

type Rectangle = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

type Point = Readonly<{ horizontal: number; vertical: number }>;

const centerBoundary = 0.22;
const centerPoint = 0.5;

/** Maps every point in a Widget body to a forgiving center-swap or directional split outcome. */
export const widgetDropEdgeAt = ({
  point,
  rectangle,
}: Readonly<{ point: Point; rectangle: Rectangle }>): WidgetEdge => {
  const width = rectangle.right - rectangle.left;
  const height = rectangle.bottom - rectangle.top;
  if (width <= 0 || height <= 0) return "center";
  const horizontal = (point.horizontal - rectangle.left) / width - centerPoint;
  const vertical = (point.vertical - rectangle.top) / height - centerPoint;
  if (Math.abs(horizontal) <= centerBoundary && Math.abs(vertical) <= centerBoundary) {
    return "center";
  }
  if (Math.abs(horizontal) > Math.abs(vertical)) return horizontal < 0 ? "left" : "right";
  return vertical < 0 ? "top" : "bottom";
};
