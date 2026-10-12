import {
  Accessibility,
  type DragEndEvent,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { GripVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Option } from "effect";
import { type JSX, type ReactNode, useRef } from "react";
import { dashboardAnnouncements, dashboardCollisionPriority } from "./drag-accessibility";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import { freshWidgetId } from "./editor-model";
import type { DashboardGesture } from "./editor-model";
import { dashboardTargetAcceptsSource, resolveDashboardDrop } from "./drag-model";

type DashboardDragData = DashboardDragSource | DashboardDropTarget;
const emptyCandidateId = Option.none<ReturnType<typeof freshWidgetId>>();
const deliberatePointer = PointerSensor.configure({
  activationConstraints: (event) =>
    event.pointerType === "touch"
      ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
      : [new PointerActivationConstraints.Distance({ value: 8 })],
});

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

/** Keeps hover feedback local and emits one closed gesture at completion. */
export const DashboardDragProvider = ({
  children,
  onGesture,
}: Readonly<{
  children: ReactNode;
  onGesture: (gesture: DashboardGesture) => void;
}>): JSX.Element => {
  const candidateId = useRef(emptyCandidateId);
  const resolve = (
    event: Pick<DragEndEvent, "operation">,
    canceled: boolean
  ): Option.Option<DashboardGesture> =>
    resolveDashboardDrop({
      canceled,
      makeWidgetId: () => Option.getOrThrow(candidateId.current),
      source: decodeDashboardDragSource(event.operation.source?.data),
      target: resolvedTarget(event),
    });
  return (
    <DragDropProvider<DashboardDragData>
      onDragStart={() => {
        candidateId.current = Option.some(freshWidgetId());
      }}
      onDragEnd={(event) => {
        const gesture = resolve(event, event.canceled);
        candidateId.current = Option.none();
        if (Option.isSome(gesture)) onGesture(gesture.value);
      }}
      plugins={(defaults) => [...defaults, dashboardAccessibility]}
      sensors={(defaults) => [
        ...defaults.filter((sensor) => sensor !== PointerSensor),
        deliberatePointer,
      ]}
    >
      {children}
    </DragDropProvider>
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
      <HugeiconsIcon
        aria-hidden="true"
        className="size-4"
        icon={GripVerticalIcon}
        strokeWidth={2}
      />
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
    return (
      <section
        aria-label={label}
        className={`dashboard-drop-zone pointer-events-none absolute z-20 h-16 ${position} ${active ? "dashboard-drop-active" : ""}`}
        ref={ref}
      >
        {active ? <span className="dashboard-placement-label">{label}</span> : null}
      </section>
    );
  }
  return (
    <section
      aria-label={label}
      className={`dashboard-drop-zone pointer-events-none absolute z-20 ${widgetTargetClass[target.edge]} ${active ? "dashboard-drop-active" : ""}`}
      ref={ref}
    >
      {active ? <span className="dashboard-placement-label">{label}</span> : null}
    </section>
  );
};
