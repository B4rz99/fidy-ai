import {
  Accessibility,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Draggable,
} from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/react";
import { Option } from "effect";
import { GripVertical } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import { freshWidgetId } from "./editor-model";
import type { DashboardGesture } from "./editor-model";
import { resolveDashboardDrop } from "./drag-model";

type DashboardDragData = DashboardDragSource | DashboardDropTarget;

const { decodeSource: decodeDashboardDragSource, decodeTarget: decodeDashboardDropTarget } =
  dashboardDragData;

const sourceLabel = (source: DashboardDragSource): string =>
  source.kind === "widget" ? source.label : source.entry.name;

const targetLabel = (target: DashboardDropTarget): string => {
  if (target.kind === "dashboard-edge") {
    return target.edge === "top" ? "inicio del tablero" : "final del tablero";
  }
  switch (target.edge) {
    case "top":
      return "arriba del Widget";
    case "right":
      return "a la derecha del Widget";
    case "bottom":
      return "debajo del Widget";
    case "left":
      return "a la izquierda del Widget";
  }
};

const dashboardAccessibility = Accessibility.configure({
  screenReaderInstructions: {
    draggable:
      "Para mover, presiona Espacio o Enter. Usa las flechas y confirma con Espacio o Enter. Cancela con Escape.",
  },
  announcements: {
    dragstart: ({ operation: { source } }: DragStartEvent) => {
      const data = source?.data;
      return Option.match(decodeDashboardDragSource(data), {
        onNone: () => undefined,
        onSome: (sourceData) => `Moviendo ${sourceLabel(sourceData)}.`,
      });
    },
    dragover: ({ operation: { source, target } }: DragOverEvent) => {
      const sourceData = source?.data;
      const targetData = target?.data;
      const decodedSource = decodeDashboardDragSource(sourceData);
      const decodedTarget = decodeDashboardDropTarget(targetData);
      return Option.isSome(decodedSource) && Option.isSome(decodedTarget)
        ? `${sourceLabel(decodedSource.value)} sobre ${targetLabel(decodedTarget.value)}.`
        : undefined;
    },
    dragend: ({ operation: { source, target }, canceled }: DragEndEvent) => {
      const sourceData = source?.data;
      const targetData = target?.data;
      const decodedSource = decodeDashboardDragSource(sourceData);
      if (Option.isNone(decodedSource)) return undefined;
      if (canceled) return `Movimiento de ${sourceLabel(decodedSource.value)} cancelado.`;
      return Option.match(decodeDashboardDropTarget(targetData), {
        onNone: () => `${sourceLabel(decodedSource.value)} no fue movido.`,
        onSome: (decodedTarget) =>
          `${sourceLabel(decodedSource.value)} colocado en ${targetLabel(decodedTarget)}.`,
      });
    },
  },
});

const completeDrag = (
  event: DragEndEvent,
  onGesture: (gesture: DashboardGesture) => void
): void => {
  const gesture = resolveDashboardDrop({
    canceled: event.canceled,
    makeWidgetId: freshWidgetId,
    source: decodeDashboardDragSource(event.operation.source?.data),
    target: decodeDashboardDropTarget(event.operation.target?.data),
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
    <DragOverlay>
      {(source: Draggable<DashboardDragData>) => {
        const data = decodeDashboardDragSource(source.data);
        return Option.isSome(data) ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-lg">
            {sourceLabel(data.value)}
          </div>
        ) : null;
      }}
    </DragOverlay>
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

const edgeClass: Record<DashboardDropTarget["edge"], string> = {
  top: "inset-x-8 top-0 h-6 -translate-y-1/2",
  right: "inset-y-8 right-0 w-6 translate-x-1/2",
  bottom: "inset-x-8 bottom-0 h-6 translate-y-1/2",
  left: "inset-y-8 left-0 w-6 -translate-x-1/2",
};

/** Geometry-only destination; semantic data remains in the adapter. */
export const DashboardDropZone = ({
  depth,
  disabled,
  label,
  target,
}: Readonly<{
  depth: number;
  disabled: boolean;
  label: string;
  target: DashboardDropTarget;
}>): JSX.Element => {
  const { isDropTarget: active, ref } = useDroppable<DashboardDragData>({
    disabled,
    id:
      target.kind === "dashboard-edge"
        ? `dashboard-edge:${target.edge}`
        : `widget-edge:${target.widgetId}:${target.edge}`,
    type: "dashboard-placement",
    accept: "dashboard-item",
    collisionPriority: depth,
    data: target,
  });
  const geometryClass =
    target.kind === "dashboard-edge"
      ? "relative z-20 h-8 w-full"
      : `absolute z-20 ${edgeClass[target.edge]}`;
  return (
    <section
      aria-label={label}
      className={`pointer-events-auto rounded-md border-2 border-dashed transition-colors ${geometryClass} ${
        active ? "border-primary bg-primary/20" : "border-muted-foreground/25 bg-background/70"
      }`}
      ref={ref}
    />
  );
};
