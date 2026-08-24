import type { CSSProperties } from "react";
import type { CanonicalSuccess } from "@/transport/client";

/** Canonical Dashboard values remain derived from the server-owned operation response. */
export type DashboardView = CanonicalSuccess<"dashboard.getDashboardView">["data"];
export type DashboardLayout = DashboardView["layout"];
export type DashboardWidgetView = Extract<DashboardLayout, { readonly kind: "leaf" }>["widget"];
export type DashboardWidget = DashboardWidgetView["widget"];

/** Mobile always stacks; desktop alone applies the canonical split axis. */
export const responsiveSplitClass = (axis: "row" | "column"): string =>
  axis === "row" ? "flex-col md:flex-row" : "flex-col";

/** Exposes a private CSS variable so canonical weights apply only at the desktop breakpoint. */
export const weightedChildStyle = (weight: number): CSSProperties => {
  const style: CSSProperties & { readonly "--dashboard-weight": number } = {
    "--dashboard-weight": weight,
  };
  return style;
};
