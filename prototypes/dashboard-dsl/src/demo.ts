// PROTOTYPE (ticket 009) — scripted walkthrough. `bun run demo`.
// Drives the SAME split-tree document through both editors and shows every case,
// including the loud rejections. Deterministic, so it doubles as the artifact.
//
// Every step feeds plain JSON through `applyRawEdit`. In the real system the UI
// builds these as compile-time-typed `DashboardEdit` values and the agent emits them
// as JSON, but BOTH hit the same two decode gates on the server.
import { Either } from "effect"
import type { DashboardDocument } from "./document.ts"
import { applyRawEdit } from "./document.ts"
import {
  exampleAgentAddRestaurants,
  exampleAgentSplitBeside,
  exampleAgentMalformed,
} from "./agent-tools.ts"
import { catalog } from "./catalog.ts"
import { seedDocument } from "./seed.ts"
import { renderDocument, ok, rejected, B, D } from "./render.ts"

let doc: DashboardDocument = seedDocument
const step = (title: string) => console.log(`\n${B("── " + title)}\n`)

const run = (label: string, rawEdit: unknown) => {
  const result = applyRawEdit(doc, rawEdit)
  if (Either.isRight(result)) {
    doc = result.right
    console.log(ok(label))
    console.log(renderDocument(doc))
  } else {
    console.log(rejected(`${label}\n   ${result.left.reason.split("\n")[0]}`))
    console.log(D("   (document unchanged)"))
  }
}

console.log(B("\nDashboard-as-document DSL — split-tree prototype\n"))
console.log(D("Start state:"))
console.log(renderDocument(doc))

// 1. UI: user drags the transaction list to sit BELOW the budget (split its region, column).
step("1. UI — split the budget region vertically, list moves below it")
run("move w-recent below w-budget-domicilios", {
  op: "move-widget",
  widgetId: "w-recent",
  at: { besideWidget: "w-budget-domicilios", axis: "column", side: "after" },
})

// 2. UI: user drags the divider — make the spending chart twice as tall (resize).
step("2. UI — resize: give the spending chart weight 4")
run("resize w-spend → weight 4", { op: "resize-widget", widgetId: "w-spend", weight: 4 })

// 2b. UI: user opens the catalog and adds a widget. There is no empty canvas — adding
// means picking an out-of-the-box widget and splitting a region to make room for it.
step("2b. UI — add from the catalog (below the transaction list)")
console.log(D("   catalog: " + catalog.map((e) => e.name).join(" · ")))
const budgetEntry = catalog.find((e) => e.name === "Barra de presupuesto")!
run("add 'Barra de presupuesto' below w-recent", {
  op: "add-widget",
  at: { besideWidget: "w-recent", axis: "column", side: "after" },
  widget: budgetEntry.make("w-budget-mercado"),
})

// 3. Agent: "agrega gasto en restaurantes arriba" — stacks a new row on top.
step("3. Agent — 'agrega un widget de gasto en restaurantes arriba'")
console.log(D("   raw: " + JSON.stringify(exampleAgentAddRestaurants)))
run("agent add w-restaurants @top", exampleAgentAddRestaurants)

// 4. Agent: split a region horizontally — new metric BESIDE the budget bar (halve a half).
step("4. Agent — split beside: put a domicilios metric next to the budget (row)")
console.log(D("   raw: " + JSON.stringify(exampleAgentSplitBeside)))
run("agent split w-domicilios-count beside w-budget-domicilios", exampleAgentSplitBeside)

// 5. Agent MALFORMED (groupBy='yearly'): rejected at gate 1, doc untouched.
step("5. Agent — MALFORMED (groupBy='yearly'): must fail loudly")
console.log(D("   raw: " + JSON.stringify(exampleAgentMalformed)))
run("agent add w-bad (invalid groupBy)", exampleAgentMalformed)

// 6. Unknown region: split beside a widget that isn't there → loud.
step("6. Split beside an unknown widget: must fail loudly")
run("add beside w-nope", {
  op: "add-widget",
  at: { besideWidget: "w-nope", axis: "row", side: "after" },
  widget: { type: "transaction-list", id: "w-x", limit: 5 },
})

// 7. Duplicate id → gate 2 (document decode) rejects.
step("7. Duplicate id: must fail loudly")
run("agent add duplicate id w-recent", {
  op: "add-widget",
  at: "bottom",
  widget: { type: "transaction-list", id: "w-recent", limit: 5 },
})

console.log(`\n${B("Final document")}`)
console.log(renderDocument(doc))
console.log(
  D(
    "\nEvery rejection left the document untouched. Both editors used the same edit\nvocabulary; the agent named regions and axes, never pixels; and the 2D tree\nalways reflows to the deterministic mobile column above. That is the answer.\n",
  ),
)
