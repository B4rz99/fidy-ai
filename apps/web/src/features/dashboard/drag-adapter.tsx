import {
  Accessibility,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/dom";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { Option } from "effect";
import { GripVertical } from "lucide-react";
import { createContext, useContext, useState } from "react";
import type { JSX, ReactNode } from "react";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import { freshWidgetId } from "./editor-model";
import type { DashboardGesture } from "./editor-model";
import { dashboardDropPreview, resolveDashboardDrop } from "./drag-model";

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
    case "center":
      return "el centro del Widget para intercambiar posiciones";
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
        ? `${sourceLabel(decodedSource.value)}. ${target?.element?.getAttribute("aria-label") ?? targetLabel(decodedTarget.value)}.`
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
          `${sourceLabel(decodedSource.value)}. ${target?.element?.getAttribute("aria-label") ?? targetLabel(decodedTarget)}.`,
      });
    },
  },
});

const resolvedTarget = (
  event: Pick<DragEndEvent | DragMoveEvent, "operation">
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

const DropPreview = createContext<Option.Option<DashboardDropTarget>>(Option.none());
const ActiveSource = createContext<Option.Option<DashboardDragSource>>(Option.none());

/** Owns all dnd-kit lifecycle and emits only closed Dashboard gestures. */
export const DashboardDragProvider = ({
  children,
  onGesture,
}: Readonly<{
  children: ReactNode;
  onGesture: (gesture: DashboardGesture) => void;
}>): JSX.Element => {
  const [preview, setPreview] = useState<Option.Option<DashboardDropTarget>>(Option.none());
  const [source, setSource] = useState<Option.Option<DashboardDragSource>>(Option.none());
  return (
    <ActiveSource value={source}>
      <DropPreview value={preview}>
        <DragDropProvider<DashboardDragData>
          onDragStart={(event) =>
            setSource(decodeDashboardDragSource(event.operation.source?.data))
          }
          onDragEnd={(event) => {
            setPreview(Option.none());
            setSource(Option.none());
            completeDrag(event, onGesture);
          }}
          onDragMove={(event) =>
            setPreview(
              dashboardDropPreview({
                source: decodeDashboardDragSource(event.operation.source?.data),
                target: resolvedTarget(event),
              })
            )
          }
          plugins={(defaults) => [...defaults, dashboardAccessibility]}
        >
          {children}
        </DragDropProvider>
      </DropPreview>
    </ActiveSource>
  );
};

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

const targetIsPreviewed = (
  preview: Option.Option<DashboardDropTarget>,
  target: DashboardDropTarget
): boolean =>
  Option.exists(preview, (candidate) =>
    target.kind === "dashboard-edge"
      ? candidate.kind === "dashboard-edge" && candidate.edge === target.edge
      : candidate.kind === "widget-edge" &&
        candidate.widgetId === target.widgetId &&
        candidate.edge === target.edge
  );

const sourceOwnsTarget = (
  source: Option.Option<DashboardDragSource>,
  target: DashboardDropTarget
): boolean =>
  target.kind === "widget-edge" &&
  Option.exists(
    source,
    (candidate) => candidate.kind === "widget" && candidate.widgetId === target.widgetId
  );

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
  const preview = useContext(DropPreview);
  const source = useContext(ActiveSource);
  const isOwnWidget = sourceOwnsTarget(source, target);
  const { ref } = useDroppable<DashboardDragData>({
    disabled: disabled || isOwnWidget,
    id:
      target.kind === "dashboard-edge"
        ? `dashboard-edge:${target.edge}`
        : `widget:${target.widgetId}:${target.edge}`,
    type: "dashboard-placement",
    accept: "dashboard-item",
    collisionPriority: depth,
    data: target,
  });
  const active = targetIsPreviewed(preview, target);
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
