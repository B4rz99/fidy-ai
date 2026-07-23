// PROTOTYPE (ticket 009) — throwaway terminal renderers. Shell only.
// The important one is renderBoxes: it partitions a rectangle by the split tree so
// you can SEE the 2D layout (side-by-side, stacked, quarters), not just a tree dump.
import type { LayoutNode, Widget, DashboardDocument } from "./document.ts"
import { flattenInOrder } from "./document.ts"

const B = (s: string) => `\x1b[1m${s}\x1b[0m`
const D = (s: string) => `\x1b[2m${s}\x1b[0m`
const G = (s: string) => `\x1b[32m${s}\x1b[0m`
const R = (s: string) => `\x1b[31m${s}\x1b[0m`

const shortType: Record<Widget["type"], string> = {
  "spending-chart": "chart",
  "budget-bar": "budget",
  "transaction-list": "list",
  "custom-metric": "metric",
}

const label = (w: Widget) => w.title ?? shortType[w.type]

// ── partition a rectangle into leaf rectangles ──────────────────────────────────
type Rect = {
  readonly widget: Widget
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

// Split `size` among integer weights, giving any remainder to the earliest slices.
const shares = (size: number, weights: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = weights.reduce((a, b) => a + b, 0)
  const base = weights.map((wt) => Math.floor((size * wt) / total))
  let rem = size - base.reduce((a, b) => a + b, 0)
  return base.map((b) => (rem-- > 0 ? b + 1 : b))
}

const rects = (
  node: LayoutNode,
  x: number,
  y: number,
  w: number,
  h: number,
): ReadonlyArray<Rect> => {
  if (node.kind === "leaf") return [{ widget: node.widget, x, y, w, h }]
  const weights = node.children.map((c) => c.weight)
  if (node.axis === "row") {
    const cols = shares(w, weights)
    let cx = x
    return node.children.flatMap((c, i) => {
      const r = rects(c.node, cx, y, cols[i]!, h)
      cx += cols[i]!
      return r
    })
  }
  const rows = shares(h, weights)
  let cy = y
  return node.children.flatMap((c, i) => {
    const r = rects(c.node, x, cy, w, rows[i]!)
    cy += rows[i]!
    return r
  })
}

// ── draw rectangles into a character grid ───────────────────────────────────────
export const renderBoxes = (node: LayoutNode, w = 74, h = 26): string => {
  const grid: string[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => " "),
  )
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && x < w && y >= 0 && y < h) grid[y]![x] = ch
  }
  for (const r of rects(node, 0, 0, w, h)) {
    const x2 = r.x + r.w - 1
    const y2 = r.y + r.h - 1
    for (let x = r.x; x <= x2; x++) {
      put(x, r.y, "─")
      put(x, y2, "─")
    }
    for (let y = r.y; y <= y2; y++) {
      put(r.x, y, "│")
      put(x2, y, "│")
    }
    put(r.x, r.y, "┌")
    put(x2, r.y, "┐")
    put(r.x, y2, "└")
    put(x2, y2, "┘")
    const text = ` ${label(r.widget)} `.slice(0, Math.max(0, r.w - 2))
    const id = ` ${r.widget.id} `.slice(0, Math.max(0, r.w - 2))
    ;[...text].forEach((ch, i) => put(r.x + 1 + i, r.y + 1, ch))
    if (r.h > 3) [...id].forEach((ch, i) => put(r.x + 1 + i, r.y + 2, ch))
  }
  return grid.map((row) => row.join("")).join("\n")
}

// ── the tree, indented ──────────────────────────────────────────────────────────
export const renderTree = (node: LayoutNode, depth = 0): string => {
  const pad = "  ".repeat(depth)
  if (node.kind === "leaf")
    return `${pad}${B(label(node.widget))} ${D(`[${node.widget.type} · ${node.widget.id}]`)}`
  const head = `${pad}${D(`split ${node.axis}`)}`
  const kids = node.children.map(
    (c) => `${D(`${"  ".repeat(depth + 1)}·w${c.weight}`)}\n${renderTree(c.node, depth + 2)}`,
  )
  return [head, ...kids].join("\n")
}

// ── the mobile reflow: flatten in-order to a single column ──────────────────────
export const renderMobile = (node: LayoutNode): string =>
  flattenInOrder(node)
    .map((w, i) => `  ${D(String(i).padStart(2))} │ ${B(label(w))} ${D(`[${shortType[w.type]}]`)}`)
    .join("\n")

export const renderDocument = (doc: DashboardDocument): string =>
  [
    `${B("╭─ " + doc.title)}  ${D(`(v${doc.version} · ${doc.id})`)}`,
    "",
    `${D("desktop layout (2D):")}`,
    renderBoxes(doc.layout),
    "",
    `${D("→ reflows on mobile to:")}`,
    renderMobile(doc.layout),
  ].join("\n")

export const ok = (s: string) => G(`✔ ${s}`)
export const rejected = (s: string) => R(`x REJECTED: ${s}`)
export { B, D }
