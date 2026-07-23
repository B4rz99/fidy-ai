// PROTOTYPE (ticket 009) — interactive TUI. `bun run tui`.
// A thin shell over the pure core. Each keystroke builds a raw edit and pushes it
// through the same `applyRawEdit` both real editors use, then re-renders the frame.
import { Either } from "effect"
import type { DashboardDocument } from "./document.ts"
import { applyRawEdit, widgetIds } from "./document.ts"
import { catalog } from "./catalog.ts"
import { exampleAgentAddRestaurants, exampleAgentMalformed } from "./agent-tools.ts"
import { seedDocument } from "./seed.ts"
import { renderDocument, B, D } from "./render.ts"

let doc: DashboardDocument = seedDocument
let msg = D("Add from the catalog, then split / resize / move. Watch the 2D layout.")
let addAxis: "row" | "column" = "row" // where a catalog add lands relative to the cursor

const apply = (label: string, rawEdit: unknown) => {
  const result = applyRawEdit(doc, rawEdit)
  if (Either.isRight(result)) {
    doc = result.right
    msg = `\x1b[32m✔ ${label}\x1b[0m`
  } else {
    msg = `\x1b[31mx REJECTED: ${label}\n   ${result.left.reason.split("\n")[0]}\x1b[0m`
  }
}

// Cursor: which widget subsequent add/resize/move/remove ops target. Cycled with [.].
let cursor = 0
const cursorId = () => widgetIds(doc.layout)[cursor % widgetIds(doc.layout).length]!

let n = 0 // unique ids for added widgets

const frame = () => {
  console.clear()
  console.log(renderDocument(doc))
  console.log(
    `\n${D("cursor →")} ${B(cursorId())}    ${D("add lands:")} ${B(addAxis === "row" ? "beside (row)" : "below (column)")}`,
  )
  console.log("\n" + msg + "\n")
  console.log(
    B("add from catalog (splits the cursor's region to make room):") +
      "  " +
      catalog.map((e) => `${B("[" + e.key + "]")} ${D(e.name)}`).join("   "),
  )
  console.log(
    [
      `${B("[.]")} ${D("next widget")}`,
      `${B("[/]")} ${D("toggle add axis")}`,
      `${B("[+]/[-]")} ${D("resize cursor")}`,
      `${B("[t]")} ${D("move cursor → top")}`,
      `${B("[x]")} ${D("remove cursor")}`,
    ].join("   "),
  )
  console.log(
    [
      `${B("[a]")} ${D("agent: add restaurants @top")}`,
      `${B("[m]")} ${D("agent: MALFORMED (rejects)")}`,
      `${B("[q]")} ${D("quit")}`,
    ].join("   "),
  )
}

const weightOf = (id: string): number => {
  const find = (node: (typeof doc)["layout"]): number | undefined => {
    if (node.kind === "leaf") return undefined
    for (const c of node.children) {
      if (c.node.kind === "leaf" && c.node.widget.id === id) return c.weight
      const r = find(c.node)
      if (r !== undefined) return r
    }
    return undefined
  }
  return find(doc.layout) ?? 1
}

const addFromCatalog = (key: string) => {
  const entry = catalog.find((e) => e.key === key)
  if (!entry) return
  apply(`add "${entry.name}" ${addAxis === "row" ? "beside" : "below"} ${cursorId()}`, {
    op: "add-widget",
    at: { besideWidget: cursorId(), axis: addAxis, side: "after" },
    widget: entry.make(`w-add-${n++}`),
  })
}

const handlers: Record<string, () => void> = {
  ".": () => (cursor = (cursor + 1) % widgetIds(doc.layout).length),
  "/": () => (addAxis = addAxis === "row" ? "column" : "row"),
  "+": () =>
    apply(`resize ${cursorId()} +1`, {
      op: "resize-widget",
      widgetId: cursorId(),
      weight: weightOf(cursorId()) + 1,
    }),
  "-": () =>
    apply(`resize ${cursorId()} -1`, {
      op: "resize-widget",
      widgetId: cursorId(),
      weight: Math.max(1, weightOf(cursorId()) - 1),
    }),
  t: () => apply(`move ${cursorId()} → top`, { op: "move-widget", widgetId: cursorId(), at: "top" }),
  x: () => apply(`remove ${cursorId()}`, { op: "remove-widget", widgetId: cursorId() }),
  a: () => apply("agent add restaurants @top", exampleAgentAddRestaurants),
  m: () => apply("agent malformed add", exampleAgentMalformed),
}

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding("utf8")
frame()
process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "") {
    process.stdin.setRawMode?.(false)
    console.log("\nbye\n")
    process.exit(0)
  }
  if (catalog.some((e) => e.key === key)) addFromCatalog(key)
  else handlers[key]?.()
  if (cursor >= widgetIds(doc.layout).length) cursor = 0
  frame()
})
