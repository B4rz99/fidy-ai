// PROTOTYPE (ticket 009) — a seed split-tree to drive the TUI/demo. Throwaway.
// Layout: a top metric strip (two metrics side-by-side), then the spending chart,
// then a budget bar beside the transaction list.
import { decodeDocument } from "./document.ts"
import { Either } from "effect"

const raw = {
  version: 1,
  id: "dash-user-001",
  title: "Mi tablero",
  layout: {
    kind: "split",
    axis: "column", // stacked top-to-bottom
    children: [
      {
        weight: 1,
        node: {
          kind: "split",
          axis: "row", // two metrics side-by-side
          children: [
            {
              weight: 1,
              node: {
                kind: "leaf",
                widget: {
                  type: "custom-metric",
                  id: "w-total",
                  title: "Gasto del mes",
                  label: "Total gastado",
                  aggregation: "sum",
                  period: "this-month",
                },
              },
            },
            {
              weight: 1,
              node: {
                kind: "leaf",
                widget: {
                  type: "custom-metric",
                  id: "w-count",
                  title: "Nº de movimientos",
                  label: "Movimientos",
                  aggregation: "count",
                  period: "this-month",
                },
              },
            },
          ],
        },
      },
      {
        weight: 2,
        node: {
          kind: "leaf",
          widget: {
            type: "spending-chart",
            id: "w-spend",
            title: "Gasto por categoría",
            groupBy: "category",
            period: "this-month",
          },
        },
      },
      {
        weight: 2,
        node: {
          kind: "split",
          axis: "row", // budget beside the list
          children: [
            {
              weight: 1,
              node: {
                kind: "leaf",
                widget: {
                  type: "budget-bar",
                  id: "w-budget-domicilios",
                  title: "Presupuesto domicilios",
                  category: "domicilios",
                  period: "this-month",
                  limitCop: 300000,
                },
              },
            },
            {
              weight: 1,
              node: {
                kind: "leaf",
                widget: {
                  type: "transaction-list",
                  id: "w-recent",
                  title: "Últimos movimientos",
                  limit: 10,
                },
              },
            },
          ],
        },
      },
    ],
  },
}

export const seedDocument = Either.getOrThrowWith(
  decodeDocument(raw),
  (e) => new Error(`seed document is invalid: ${e.message}`),
)
