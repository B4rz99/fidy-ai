import {
  type Accessibility,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/dom";
import { Option } from "effect";
import { dashboardDragData } from "./drag-data";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";

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

const destinationLabel = (target: DashboardDropTarget, ariaLabel: Option.Option<string>): string =>
  Option.getOrElse(ariaLabel, () => targetLabel(target));

/** Localized semantic announcement text, independent of dnd-kit's event object shape. */
export const dashboardAnnouncementText = {
  started: (sourceData: unknown): Option.Option<string> =>
    Option.map(
      decodeDashboardDragSource(sourceData),
      (source) => `Moviendo ${sourceLabel(source)}.`
    ),
  over: (
    sourceData: unknown,
    targetData: unknown,
    targetAriaLabel: Option.Option<string>
  ): Option.Option<string> =>
    Option.flatMap(decodeDashboardDragSource(sourceData), (source) =>
      Option.map(
        decodeDashboardDropTarget(targetData),
        (target) => `${sourceLabel(source)}. ${destinationLabel(target, targetAriaLabel)}.`
      )
    ),
  ended: ({
    canceled,
    sourceData,
    targetAriaLabel,
    targetData,
  }: Readonly<{
    canceled: boolean;
    sourceData: unknown;
    targetAriaLabel: Option.Option<string>;
    targetData: unknown;
  }>): Option.Option<string> =>
    Option.map(decodeDashboardDragSource(sourceData), (source) => {
      if (canceled) return `Movimiento de ${sourceLabel(source)} cancelado.`;
      return Option.match(decodeDashboardDropTarget(targetData), {
        onNone: () => `${sourceLabel(source)} no fue movido.`,
        onSome: (target) => `${sourceLabel(source)}. ${destinationLabel(target, targetAriaLabel)}.`,
      });
    }),
};

/** Localized dnd-kit callbacks delegated to the independently tested semantic text. */
type AccessibilityOptions = NonNullable<ConstructorParameters<typeof Accessibility>[1]>;
type DashboardAnnouncements = Required<AccessibilityOptions>["announcements"];

export const dashboardAnnouncements: DashboardAnnouncements = {
  dragstart: ({ operation: { source } }: DragStartEvent) =>
    Option.getOrUndefined(dashboardAnnouncementText.started(source?.data)),
  dragover: ({ operation: { source, target } }: DragOverEvent) =>
    Option.getOrUndefined(
      dashboardAnnouncementText.over(
        source?.data,
        target?.data,
        Option.fromNullishOr(target?.element?.getAttribute("aria-label"))
      )
    ),
  dragend: ({ operation: { source, target }, canceled }: DragEndEvent) =>
    Option.getOrUndefined(
      dashboardAnnouncementText.ended({
        canceled,
        sourceData: source?.data,
        targetAriaLabel: Option.fromNullishOr(target?.element?.getAttribute("aria-label")),
        targetData: target?.data,
      })
    ),
};

/** Numeric collision ordering where deeper recursive regions win overlapping targets. */
export const dashboardCollisionPriority = (depth: number): number => depth;
