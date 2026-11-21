import { Data } from "effect";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";

export const sourceLabel = (source: DashboardDragSource): string =>
  source.kind === "widget" ? source.label : source.entry.name;

export type DashboardDragOutcome = Data.TaggedEnum<{
  Canceled: {};
  Unplaced: {};
  Placed: { readonly destination: string };
}>;

export const DashboardDragOutcome = Data.taggedEnum<DashboardDragOutcome>();

export const dashboardDragAnnouncement = {
  started: (label: string): string => `Moviendo ${label}.`,
  over: (label: string, destination: string): string => `${label}. ${destination}.`,
  ended: ({
    label,
    outcome,
  }: Readonly<{
    label: string;
    outcome: DashboardDragOutcome;
  }>): string =>
    DashboardDragOutcome.$match(outcome, {
      Canceled: () => `Movimiento de ${label} cancelado.`,
      Unplaced: () => `${label} no fue movido.`,
      Placed: ({ destination }) => `${label}. ${destination}.`,
    }),
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
