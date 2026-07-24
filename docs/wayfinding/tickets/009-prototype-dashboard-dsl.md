---
id: 009
title: "Prototype: dashboard-as-document DSL"
label: wayfinder:prototype
status: closed
assignee: obarboza
blocked-by: []
resolved: 2026-07-23
---

## Question

What does the declarative dashboard document look like, concretely? Build a throwaway prototype (via /prototype) to react to:

- Block/widget schema (spending chart, budget bar, transaction list, custom metric) and layout model.
- The same document edited two ways: a user drag-drop/settings interaction, and an agent tool call ("add a restaurants-spending widget at the top").
- Where the document lives and how edits are validated (the type-strict, no-silent-fallback constraint applies to the DSL itself).

Resolution = the DSL's shape is decided and linked as an asset; the prototype is throwaway.

## Resolution (2026-07-23)

Prototyped and reacted to with obarboza over three HITL iterations; shape **locked**.

**Asset**: throwaway prototype on branch **`prototype/dashboard-dsl`** (`prototypes/dashboard-dsl/`,
final commit `3e82ce8`). Portable core `src/document.ts` (schema + recursive split tree

- edit DSL + pure reducer; zero I/O — lifts into the real codebase). `bunx tsc --noEmit`
  passes under `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
  `bun run demo` walks every case; `bun run tui` drives it by hand.

**HITL path**: v1 an ordered flat list (reorder + `full`/`half`) → rejected as not real
customization; v2 (`a4713d7`) reworked to a recursive split tree; v3 (`3e82ce8`) added the
widget catalog after "how do I add stuff back?". v3 confirmed ("THIS IS IT").

### The locked shape

1. **Layout is a recursive split tree** — a node is a **widget leaf** or a **split** with
   weighted children. `axis: row` = children side-by-side (vertical divider); `column` =
   stacked (horizontal divider). Any region splits either way, recursively ("halve a half").
   NOT a flat list, NOT pixel coordinates.
2. **Size = a child's integer `weight`** within its split (`1:1` halves, `1:1:1` thirds,
   `3:1` = 75/25). Real resizing; no fixed `full`/`half`.
3. **Positions are structural, never geometric** — an edit names a _region_ (widget id) +
   _axis/side_, never x/y/w/h. This is what frees the agent from collision math and removes
   any need for per-breakpoint layouts.
4. **Every tree reflows to one deterministic mobile column** via in-order leaf traversal
   (`flattenInOrder`) — order is unambiguous no matter how nested the 2D layout.
5. **Widget = discriminated union on `type`** (`spending-chart`, `budget-bar`,
   `transaction-list`, `custom-metric`), stable `id`, optional `title`, per-type config.
   Periods are a closed enum.
6. **Adding = pick from a catalog + split a region.** No empty canvas — the screen is
   always fully tiled, so making room means splitting. The **catalog** (`src/catalog.ts`)
   is the out-of-the-box "+ Add" palette: one entry per widget type, a factory for a valid
   default-configured widget. It's what the UI menu renders and what the agent chooses from.
7. **One shared `DashboardEdit` vocabulary both editors emit**: `add-widget` (+`Placement`),
   `remove-widget`, `move-widget`, `resize-widget`, `update-widget`, `set-title`.
   `Placement = "top" | "bottom" | { besideWidget, axis, side }`. A UI split/drag/resize and
   an agent tool call compile to the _same_ op; the agent has no privileged path.
8. **All-or-nothing at two loud decode gates**: (1) the edit itself (agent boundary =
   untrusted LLM JSON); (2) the resulting document (unique ids, every split ≥2 children,
   positive weights, per-type config). Failure → `Left(EditError)`, document untouched — no
   coercion, no partial apply. Reducer invariants: single-child splits collapse; the last
   widget can't be removed.
9. **Lives as a `jsonb` row (ticket 011), never trusted raw** — decoded on every read/write.
   Edit ops are canonical API operations; UI/agent/CLI/MCP share them, gated by ticket 008's
   `dashboard` scope.

### Deferred to the MVP spec / build (ticket 012) — not blocking

- **Compact agent-facing errors**: raw Effect `ParseError` dumps the whole edit union
  (unusable for an LLM/audit log). Build needs `ParseResult.ArrayFormatter` → `{ path,
message }` at the tool boundary.
- **Brand `CategoryId`/`WidgetId`** in production (prototype left them plain strings to keep
  the recursive schema readable). `CategoryId` binds to the Colombian taxonomy enum once
  that lands (map: "Colombian category taxonomy in detail").
- **Canonical form**: whether to flatten same-axis nesting on write (legal but non-minimal).
- **Minimum region size / max split depth** to stop slivers — likely UI, schema could cap.
- **Cross-check widget-referenced entities** (budgets, category filters) against user data —
  belongs on the canonical API, not the DSL.
- **Widget catalog presets** beyond the four base types (e.g. a pre-configured "domicilios
  budget") — a product-content decision for the build.
