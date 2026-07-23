# PROTOTYPE — dashboard-as-document DSL (wayfinder ticket 009)

**Throwaway.** This exists to answer one question and be reacted to, not to ship.

## The question

What does the declarative dashboard document look like, concretely, such that the
**same document** can be edited two ways — a human through the web UI, and the
user's own agent through a tool call — giving **real 2D customization** (split any
region vertically or horizontally, recursively: halves, quarters, thirds) while
staying type-strict, **no silent fallbacks** (a bad edit fails loudly and atomically),
and still reflowing to a single column on a phone?

## Run it

```
bun install
bun run demo   # scripted walkthrough; renders the 2D layout after every edit
bun run tui    # interactive: split / resize / move / add by hand
```

## The shape it lands on

- **Layout is a recursive split tree**, not a flat list and not pixel coordinates.
  A node is either a **widget leaf** or a **split** with weighted children.
  A split's `axis` is `row` (children **side-by-side**, a vertical divider) or
  `column` (children **stacked**, a horizontal divider). "Halve a half" = split a
  leaf that already lives inside a split. This is the tiling-WM / editor-pane model.

- **Size is a child's `weight`** within its split (integers). `1:1` = halves,
  `1:1:1` = thirds, `3:1` = 75/25. That's real resizing — no fixed `full`/`half`.

- **Positions stay structural, never geometric.** An edit names a *region* (a widget
  id) and an *axis/side* — never x/y/w/h. That's what lets the agent rearrange the
  layout without doing collision math, and it's why there are no per-breakpoint
  layouts to maintain.

- **Any tree reflows to one deterministic mobile column** by in-order leaf traversal
  (`flattenInOrder`). The demo prints this under every desktop layout. Order is
  never ambiguous, however the 2D arrangement is nested.

- **Widgets are a discriminated union on `type`** (`spending-chart`, `budget-bar`,
  `transaction-list`, `custom-metric`), each with a stable `id`, optional `title`,
  and per-type config validated per type. Periods are a closed enum.

- **Adding a widget = pick from the catalog + split a region.** There is no empty
  canvas to drop into: the screen is always fully tiled, so making room for a new
  widget means splitting an existing region. The **catalog** (`src/catalog.ts`) is the
  out-of-the-box palette — one entry per widget type, each a factory for a valid
  default-configured widget. It's a product concept: what the UI's "+ Add" menu shows
  and what the agent chooses from.

- **Both editors emit one shared `DashboardEdit` vocabulary**: `add-widget` (with a
  `Placement`), `remove-widget`, `move-widget`, `resize-widget`, `update-widget`,
  `set-title`. `Placement = "top" | "bottom" | { besideWidget, axis, side }`. A UI
  drag/split/resize and an agent tool call compile to the *same* op; the agent has no
  privileged path (`src/agent-tools.ts`).

- **Edits validated all-or-nothing at two loud decode gates**: (1) the edit itself —
  the agent boundary receives untrusted LLM JSON; (2) the resulting document —
  unique widget ids, every split ≥2 children, positive weights, per-type config; the
  client isn't trusted either. Any failure → `Left(EditError)`, document untouched.
  No coercion, no partial apply. Structural invariants the reducer maintains: a split
  that drops to one child **collapses** to that child; the last widget can't be removed.

- **Lives as a `jsonb` row (ticket 011), never trusted raw** — decoded through the
  schema on every read/write. Edit ops are canonical API operations; UI/agent/CLI/MCP
  all call the same ones, gated by ticket 008's `dashboard` scope.

## Files

| File | Role |
|------|------|
| `src/document.ts` | **The portable core** — schema, recursive split tree, edit DSL, pure `applyEdit` reducer, `flattenInOrder`. Zero I/O; the bit that lifts into the real codebase. |
| `src/catalog.ts` | The widget catalog — the out-of-the-box "+ Add" palette. |
| `src/agent-tools.ts` | The agent's tool surface as thin wrappers over `applyRawEdit`. |
| `src/render.ts` | Throwaway renderers, incl. the 2D box view (`renderBoxes`). |
| `src/seed.ts`, `src/demo.ts`, `src/tui.ts` | Seed tree + throwaway shells. |

## Open questions this surfaced

- **Agent-facing errors must be compacted.** The raw Effect `ParseError` for a
  malformed edit dumps the entire union type (demo step 5) — unusable for an LLM or
  audit log. Production needs `ParseResult.ArrayFormatter` → `{ path, message }` at
  the tool boundary. (This is now more pressing: the union is bigger.)
- **`CategoryId`/`WidgetId` left as plain strings here** — branding forces a dual
  encoded/type interface through the recursive schema. Production brands them; the
  Colombian taxonomy binds `CategoryId` to a closed enum (separate open decision).
- **Canonical form.** The reducer collapses single-child splits but does *not* flatten
  same-axis nesting (a `column` split directly inside a `column` split is legal but
  non-minimal). Decide whether to normalize on write.
- **Minimum region size / max split depth.** Nothing stops splitting into slivers.
  Likely a UI concern, but the schema could cap depth if we want it enforced.
- **Split-to-add vs empty-canvas.** This model has no free space — adding always
  splits a region. That's clean and always-tiled, but if users expect to drop a widget
  into blank space (or leave gaps), the model would need a different container. Worth
  a gut-check against the intended UX.
- **Widget-referenced entities** (a budget, category filters) are referenced by id;
  existence isn't cross-checked against the user's data here — belongs on the
  canonical API.
