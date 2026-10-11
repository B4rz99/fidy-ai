import { Accessibility, DragDropManager, Draggable, Droppable } from "@dnd-kit/dom";
import { Option } from "effect";
import { dashboardAnnouncements, dashboardCollisionPriority } from "./drag-accessibility";
import { type DashboardDragSource, type DashboardDropTarget, dashboardDragData } from "./drag-data";
import { dashboardTargetAcceptsSource, resolveDashboardDrop } from "./drag-model";
import { type DashboardGesture, freshWidgetId } from "./editor-model";

type Configuration = Readonly<{
  enabled: () => boolean;
  gesture: (gesture: DashboardGesture) => void;
}>;
const localizedAccessibility = Accessibility.configure({
  screenReaderInstructions: {
    draggable:
      "Para mover, presiona Espacio o Enter. Usa las flechas y confirma con Espacio o Enter. Cancela con Escape.",
  },
  announcements: dashboardAnnouncements,
});
const bindTarget =
  ({
    manager,
    enabled,
  }: Readonly<{ manager: DragDropManager; enabled: () => boolean }>): ((
    configuration: Readonly<{ element: HTMLElement; data: DashboardDropTarget; depth: number }>
  ) => () => void) =>
  ({ element, data, depth }): (() => void) => {
    const id =
      data.kind === "dashboard-edge"
        ? `dashboard-edge:${data.edge}`
        : `widget:${data.widgetId}:${data.edge}`;
    const target = new Droppable(
      {
        id,
        type: "dashboard-placement",
        data,
        element,
        collisionPriority: dashboardCollisionPriority(depth),
        accept: (source): boolean =>
          enabled() &&
          source.type === "dashboard-item" &&
          dashboardTargetAcceptsSource({
            source: dashboardDragData.decodeSource(source.data),
            target: data,
          }),
      },
      manager
    );
    const release = manager.monitor.addEventListener("dragover", ({ operation }) =>
      element.classList.toggle("dashboard-drop-active", operation.target?.id === id)
    );
    const releaseEnd = manager.monitor.addEventListener("dragend", () =>
      element.classList.remove("dashboard-drop-active")
    );
    return (): void => {
      releaseEnd();
      release();
      target.destroy();
    };
  };
/** Owns the DOM manager, default sensors, localized announcements, and guarded gesture translation. */
export const makeDashboardDragOwner = ({
  enabled,
  gesture,
}: Configuration): Readonly<{
  dispose: () => void;
  source: (element: HTMLElement, data: DashboardDragSource) => () => void;
  target: (
    configuration: Readonly<{ element: HTMLElement; data: DashboardDropTarget; depth: number }>
  ) => () => void;
}> => {
  let active = true;
  const manager = new DragDropManager({
    plugins: (defaults): typeof defaults => [...defaults, localizedAccessibility],
  });
  const releaseStart = manager.monitor.addEventListener("beforedragstart", (event) => {
    if (!active || !enabled()) event.preventDefault();
  });
  const releaseEnd = manager.monitor.addEventListener("dragend", (event) => {
    if (!active || !enabled()) return;
    const result = resolveDashboardDrop({
      canceled: event.canceled,
      makeWidgetId: freshWidgetId,
      source: dashboardDragData.decodeSource(event.operation.source?.data),
      target: dashboardDragData.decodeTarget(event.operation.target?.data),
    });
    if (Option.isSome(result)) gesture(result.value);
  });
  return {
    dispose: (): void => {
      if (!active) return;
      active = false;
      releaseStart();
      releaseEnd();
      manager.destroy();
    },
    source: (element, data): (() => void) => {
      const id =
        data.kind === "widget"
          ? `dashboard-widget:${data.widgetId}`
          : `dashboard-catalog:${data.entry.id}`;
      const source = new Draggable(
        { id, type: "dashboard-item", data, element, handle: element },
        manager
      );
      return (): void => source.destroy();
    },
    target: bindTarget({ manager, enabled: () => active && enabled() }),
  };
};
