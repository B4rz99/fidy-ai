import { Accessibility, type DragEndEvent } from "@dnd-kit/dom";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { Option } from "effect";
import { GripVertical } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { dashboardAnnouncements, dashboardCollisionPriority } from "./drag-accessibility";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import { freshWidgetId } from "./editor-model";
import type { DashboardGesture } from "./editor-model";
import { dashboardTargetAcceptsSource, resolveDashboardDrop } from "./drag-model";

type DashboardDragData = DashboardDragSource | DashboardDropTarget;

const { decodeSource: decodeDashboardDragSource, decodeTarget: decodeDashboardDropTarget } =
  dashboardDragData;

const dashboardAccessibility = Accessibility.configure({
  screenReaderInstructions: {
    draggable:
      "Para mover, presiona Espacio o Enter. Usa las flechas y confirma con Espacio o Enter. Cancela con Escape.",
  },
  announcements: dashboardAnnouncements,
});

const resolvedTarget = (
  event: Pick<DragEndEvent, "operation">
): Option.Option<DashboardDropTarget> => decodeDashboardDropTarget(event.operation.target?.data);

const completeDrag = (
  event: DragEndEvent,
  onGesture: (gesture: DashboardGesture) => void
): void => {
  const gesture = resolveDashboardDrop({
    canceled: event.canceled,
    makeWidgetId: freshWidgetId,
    source: decodeDashboardDragSource(event.operation.source?.data),
    target: resolvedTarget(event),
  });
  if (Option.isSome(gesture)) onGesture(gesture.value);
};

/** Owns all dnd-kit lifecycle and emits only closed Dashboard gestures. */
export const DashboardDragProvider = ({
  children,
  onGesture,
}: Readonly<{
  children: ReactNode;
  onGesture: (gesture: DashboardGesture) => void;
}>): JSX.Element => (
  <DragDropProvider<DashboardDragData>
    onDragEnd={(event) => completeDrag(event, onGesture)}
    plugins={(defaults) => [...defaults, dashboardAccessibility]}
  >
    {children}
  </DragDropProvider>
);

/** Visible, focusable activator for one existing or catalog Widget. */
export const DashboardDragHandle = ({
  disabled,
  label,
  source,
}: Readonly<{ disabled: boolean; label: string; source: DashboardDragSource }>): JSX.Element => {
  const { handleRef, isDragging, ref } = useDraggable<DashboardDragData>({
    id:
      source.kind === "widget"
        ? `dashboard-widget:${source.widgetId}`
        : `dashboard-catalog:${source.entry.id}`,
    type: "dashboard-item",
    data: source,
    disabled,
  });
  return (
    <button
      aria-label={label}
      aria-pressed={isDragging}
      disabled={disabled}
      className="inline-flex size-8 touch-none items-center justify-center rounded-md border bg-background text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      ref={(element) => {
        ref(element);
        handleRef(element);
      }}
      type="button"
    >
      <GripVertical aria-hidden="true" className="size-4" />
    </button>
  );
};

const widgetTargetClass: Record<
  Extract<DashboardDropTarget, { kind: "widget-edge" }>["edge"],
  string
> = {
  top: "inset-x-0 top-0 h-1/4",
  right: "inset-y-1/4 right-0 w-1/4",
  bottom: "inset-x-0 bottom-0 h-1/4",
  left: "inset-y-1/4 left-0 w-1/4",
  center: "inset-1/4",
};

type DashboardDropZoneProps = Readonly<{
  depth: number;
  disabled: boolean;
  label: string;
  target: DashboardDropTarget;
}>;

/** Geometry-only destination; semantic data remains in the adapter. */
export const DashboardDropZone = ({
  depth,
  disabled,
  label,
  target,
}: DashboardDropZoneProps): JSX.Element => {
  const { isDropTarget: active, ref } = useDroppable<DashboardDragData>({
    disabled,
    id:
      target.kind === "dashboard-edge"
        ? `dashboard-edge:${target.edge}`
        : `widget:${target.widgetId}:${target.edge}`,
    type: "dashboard-placement",
    accept: (source) =>
      source.type === "dashboard-item" &&
      dashboardTargetAcceptsSource({
        source: decodeDashboardDragSource(source.data),
        target,
      }),
    collisionPriority: dashboardCollisionPriority(depth),
    data: target,
  });
  if (target.kind === "dashboard-edge") {
    const position = target.edge === "top" ? "inset-x-0 top-0" : "inset-x-0 bottom-0";
    const indicator =
      target.edge === "top" ? "inset-x-4 top-1 border-t-2" : "inset-x-4 bottom-1 border-b-2";
    return (
      <section
        aria-label={label}
        className={`pointer-events-none absolute z-20 h-16 ${position}`}
        ref={ref}
      >
        <span
          aria-hidden="true"
          className={`absolute border-dashed transition-colors ${indicator} ${
            active ? "border-primary" : "border-transparent"
          }`}
        />
      </section>
    );
  }
  return (
    <section
      aria-label={label}
      className={`pointer-events-none absolute z-20 ${widgetTargetClass[target.edge]}`}
      ref={ref}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-1 rounded-lg border-2 bg-primary/10 transition-opacity ${
          active ? "border-primary opacity-100" : "border-transparent opacity-0"
        }`}
      />
    </section>
  );
};
