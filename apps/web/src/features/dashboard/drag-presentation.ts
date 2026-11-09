import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";

export const sourceLabel = (source: DashboardDragSource): string =>
  source.kind === "widget" ? source.label : source.entry.name;

export const dashboardDragAnnouncement = {
  started: (label: string): string => `Moviendo ${label}.`,
  over: (label: string, destination: string): string => `${label}. ${destination}.`,
  ended: ({
    label,
    outcome,
  }: Readonly<{
    label: string;
    outcome: { _tag: "Canceled" } | { _tag: "Unplaced" } | { _tag: "Placed"; destination: string };
  }>): string => {
    switch (outcome._tag) {
      case "Canceled":
        return `Movimiento de ${label} cancelado.`;
      case "Unplaced":
        return `${label} no fue movido.`;
      case "Placed":
        return `${label}. ${outcome.destination}.`;
    }
  },
};

export const dashboardCollisionPriority = (depth: number): number => depth;

export const dashboardTargetAcceptsKnownSource = ({
  source,
  target,
}: Readonly<{ source: DashboardDragSource; target: DashboardDropTarget }>): boolean =>
  !(
    source.kind === "widget" &&
    target.kind === "widget-edge" &&
    source.widgetId === target.widgetId
  );
