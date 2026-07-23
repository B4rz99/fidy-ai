// PROTOTYPE (ticket 009) — the agent's dashboard tool surface.
//
// The point: the user's agent gets NO privileged edit path. Each tool is a thin
// wrapper that builds a `DashboardEdit` (or receives raw JSON) and calls the exact
// same `applyRawEdit` the untrusted boundary uses. The agent is just another emitter
// of the shared edit vocabulary — parity with ticket 008's `dashboard` scope.
//
// Note how the agent NEVER computes geometry: it names a region (a widget id) and an
// axis/side. That is the whole reason layout is a structural tree, not coordinates.

import type { DashboardDocument } from "./document.ts"
import { applyRawEdit } from "./document.ts"

export const dashboardTool = (doc: DashboardDocument, toolInput: unknown) =>
  applyRawEdit(doc, toolInput)

// "agrega un widget de gasto en restaurantes arriba" → stack a new chart on top.
export const exampleAgentAddRestaurants = {
  op: "add-widget",
  at: "top",
  widget: {
    type: "spending-chart",
    id: "w-restaurants",
    title: "Gasto en restaurantes",
    groupBy: "month",
    period: "last-30-days",
    categories: ["restaurantes"],
  },
} as const

// "pon el nº de domicilios al lado del presupuesto de domicilios"
// → split the budget region along `row`, new metric to its right.
export const exampleAgentSplitBeside = {
  op: "add-widget",
  at: { besideWidget: "w-budget-domicilios", axis: "row", side: "after" },
  widget: {
    type: "custom-metric",
    id: "w-domicilios-count",
    title: "Domicilios este mes",
    label: "Domicilios",
    aggregation: "count",
    period: "this-month",
    categories: ["domicilios"],
  },
} as const

// MALFORMED (LLM hallucinated an unsupported groupBy) — rejected at gate 1, loudly.
export const exampleAgentMalformed = {
  op: "add-widget",
  at: "top",
  widget: {
    type: "spending-chart",
    id: "w-bad",
    groupBy: "yearly", // not in {category, day, month}
    period: "last-30-days",
  },
} as const
