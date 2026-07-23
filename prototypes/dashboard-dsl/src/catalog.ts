// PROTOTYPE (ticket 009) — the widget catalog: the "out of the box" widgets a user
// picks from when adding to their dashboard. This is a PRODUCT concept, not just a
// shell helper — it's the palette the UI renders and the menu the agent chooses from.
//
// Each entry is a factory producing a VALID default-configured widget for a given id.
// (Defaults like category "general" are placeholders until the Colombian taxonomy is
// decided — see the map's "Not yet specified".)
import type { Widget } from "./document.ts"

export type CatalogEntry = {
  readonly key: string // shortcut in the TUI
  readonly name: string // shown in the palette
  readonly make: (id: string) => Widget
}

export const catalog: ReadonlyArray<CatalogEntry> = [
  {
    key: "1",
    name: "Gráfica de gasto",
    make: (id) => ({
      type: "spending-chart",
      id,
      title: "Gasto por categoría",
      groupBy: "category",
      period: "this-month",
    }),
  },
  {
    key: "2",
    name: "Barra de presupuesto",
    make: (id) => ({
      type: "budget-bar",
      id,
      title: "Presupuesto",
      category: "general",
      period: "this-month",
      limitCop: 200000,
    }),
  },
  {
    key: "3",
    name: "Lista de movimientos",
    make: (id) => ({
      type: "transaction-list",
      id,
      title: "Últimos movimientos",
      limit: 10,
    }),
  },
  {
    key: "4",
    name: "Métrica",
    make: (id) => ({
      type: "custom-metric",
      id,
      title: "Métrica",
      label: "Total",
      aggregation: "sum",
      period: "this-month",
    }),
  },
]
