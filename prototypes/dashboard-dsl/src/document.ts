// ─────────────────────────────────────────────────────────────────────────────
// PROTOTYPE — dashboard-as-document DSL. Throwaway (ticket 009). Not production.
//
// PORTABLE core: schema + edit DSL + pure reducer. No I/O, no console. The TUI/demo
// shells import it; nothing flows back.
//
// QUESTION being answered:
//   What does the declarative dashboard document look like, concretely, such that
//   the SAME document can be edited two ways — a human through the UI, and the
//   user's agent through a tool call — giving REAL 2D customization (split any
//   region vertically or horizontally, recursively — halves, quarters, thirds),
//   while staying type-strict with NO silent fallbacks and still reflowing to a
//   single column on a phone?
//
// SHAPE OF THE ANSWER:
//   - Layout is a RECURSIVE SPLIT TREE (like tiling-WM / editor panes), NOT pixel
//     coordinates and NOT a flat list. A node is either a widget leaf or a split
//     (`row` = children side-by-side, `column` = children stacked) with weighted
//     children. "Halve a half" = split a leaf that already lives inside a split.
//   - Positions stay STRUCTURAL (which region, which axis, what weight) so an agent
//     edits without geometry, and the tree flattens in-order to one mobile column.
//   - Both editors emit one shared `DashboardEdit` vocabulary. Every edit crosses
//     two loud decode gates (the edit, then the resulting document) and is
//     all-or-nothing.
//
// NOTE: ids are plain non-empty strings here to keep the recursive schema readable.
// Production brands them (WidgetId/CategoryId) — branding forces a dual encoded/type
// interface through the recursion, which is noise for a throwaway.
// ─────────────────────────────────────────────────────────────────────────────

import { Either, Schema } from "effect"

// ── Identifiers (branded in production; see note above) ─────────────────────────
const WidgetId = Schema.NonEmptyTrimmedString
const CategoryId = Schema.NonEmptyTrimmedString

// ── Closed enums (no open strings → no silent fallback at decode) ───────────────
export const Period = Schema.Literal(
  "this-week",
  "this-month",
  "last-week",
  "last-month",
  "last-7-days",
  "last-30-days",
)
export const Aggregation = Schema.Literal("sum", "avg", "count", "max")

const AmountCop = Schema.Int.pipe(
  Schema.positive({ message: () => "amount must be a positive integer (COP)" }),
)
const CategoryFilter = Schema.optional(Schema.NonEmptyArray(CategoryId))

// ── Widgets: a discriminated union on `type` ───────────────────────────────────
const WidgetBase = { id: WidgetId, title: Schema.optional(Schema.NonEmptyTrimmedString) }

export const SpendingChart = Schema.Struct({
  type: Schema.Literal("spending-chart"),
  ...WidgetBase,
  groupBy: Schema.Literal("category", "day", "month"),
  period: Period,
  categories: CategoryFilter,
})
export const BudgetBar = Schema.Struct({
  type: Schema.Literal("budget-bar"),
  ...WidgetBase,
  category: CategoryId,
  period: Period,
  limitCop: AmountCop,
})
export const TransactionList = Schema.Struct({
  type: Schema.Literal("transaction-list"),
  ...WidgetBase,
  limit: Schema.Int.pipe(
    Schema.between(1, 50, {
      message: () => "transaction-list limit must be between 1 and 50",
    }),
  ),
  categories: CategoryFilter,
  search: Schema.optional(Schema.NonEmptyTrimmedString),
})
export const CustomMetric = Schema.Struct({
  type: Schema.Literal("custom-metric"),
  ...WidgetBase,
  label: Schema.NonEmptyTrimmedString,
  aggregation: Aggregation,
  period: Period,
  categories: CategoryFilter,
})

export const Widget = Schema.Union(SpendingChart, BudgetBar, TransactionList, CustomMetric)
export type Widget = typeof Widget.Type

// ── Layout: a recursive split tree ──────────────────────────────────────────────
// Size is a child's WEIGHT within its split, so a leaf can be any fraction (1:1 =
// halves, 1:1:1 = thirds, 3:1 = 75/25). Real resizing, no fixed full/half.

export const Axis = Schema.Literal("row", "column") // row = side-by-side, column = stacked
export type Axis = typeof Axis.Type

export interface LeafNode {
  readonly kind: "leaf"
  readonly widget: Widget
}
export interface SplitChild {
  readonly weight: number
  readonly node: LayoutNode
}
export interface SplitNode {
  readonly kind: "split"
  readonly axis: Axis
  readonly children: ReadonlyArray<SplitChild>
}
export type LayoutNode = LeafNode | SplitNode

const LeafNode = Schema.Struct({ kind: Schema.Literal("leaf"), widget: Widget })

// suspend defers the self-reference; SplitNode is in scope by call time.
const LayoutNode: Schema.Schema<LayoutNode> = Schema.suspend(() =>
  Schema.Union(LeafNode, SplitNode),
)

const SplitChild = Schema.Struct({
  weight: Schema.Int.pipe(
    Schema.positive({ message: () => "a split child weight must be a positive integer" }),
  ),
  node: LayoutNode,
})

const SplitNode: Schema.Schema<SplitNode> = Schema.Struct({
  kind: Schema.Literal("split"),
  axis: Axis,
  children: Schema.Array(SplitChild),
}).pipe(
  Schema.filter((s) =>
    s.children.length >= 2 ? undefined : "a split must have at least 2 children",
  ),
)

// ── Traversals (pure) ───────────────────────────────────────────────────────────
export const widgetIds = (node: LayoutNode): ReadonlyArray<string> =>
  node.kind === "leaf" ? [node.widget.id] : node.children.flatMap((c) => widgetIds(c.node))

const findWidget = (node: LayoutNode, id: string): Widget | undefined => {
  if (node.kind === "leaf") return node.widget.id === id ? node.widget : undefined
  for (const c of node.children) {
    const found = findWidget(c.node, id)
    if (found) return found
  }
  return undefined
}

// In-order leaf sequence — the mobile reflow. Any tree collapses to THIS single
// column, so display order is always deterministic no matter the 2D arrangement.
export const flattenInOrder = (node: LayoutNode): ReadonlyArray<Widget> =>
  node.kind === "leaf" ? [node.widget] : node.children.flatMap((c) => flattenInOrder(c.node))

// ── The document ─────────────────────────────────────────────────────────────────
const idsUnique = (node: LayoutNode): boolean => {
  const ids = widgetIds(node)
  return new Set(ids).size === ids.length
}

export const DashboardDocument = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyTrimmedString,
  title: Schema.NonEmptyTrimmedString,
  layout: LayoutNode, // a non-empty tree; a single widget is a lone leaf
}).pipe(
  Schema.filter((doc) =>
    idsUnique(doc.layout) ? undefined : "widget ids must be unique within a dashboard",
  ),
)
export type DashboardDocument = typeof DashboardDocument.Type

// ── The edit DSL: the shared vocabulary BOTH editors emit ───────────────────────
// A UI drag/split/resize and an agent tool call both compile to one of these.
// `Placement` is structural: stack at the root, or split a specific region.

export const Placement = Schema.Union(
  Schema.Literal("top"), // split the whole dashboard as a column, new widget on top
  Schema.Literal("bottom"),
  Schema.Struct({
    besideWidget: WidgetId, // split the REGION this widget occupies...
    axis: Axis, // ...along this axis (row = beside it, column = above/below it)...
    side: Schema.Literal("before", "after"), // ...placing the newcomer here
  }),
)
export type Placement = typeof Placement.Type

export const AddWidget = Schema.Struct({
  op: Schema.Literal("add-widget"),
  widget: Widget,
  at: Placement,
})
export const RemoveWidget = Schema.Struct({
  op: Schema.Literal("remove-widget"),
  widgetId: WidgetId,
})
export const MoveWidget = Schema.Struct({
  op: Schema.Literal("move-widget"),
  widgetId: WidgetId,
  at: Placement,
})
export const ResizeWidget = Schema.Struct({
  op: Schema.Literal("resize-widget"),
  widgetId: WidgetId,
  weight: Schema.Int.pipe(Schema.positive({ message: () => "weight must be a positive integer" })),
})
// Full-widget replacement (same id) — a settings change. No partial-merge patch, so
// no silent-merge fallback.
export const UpdateWidget = Schema.Struct({
  op: Schema.Literal("update-widget"),
  widget: Widget,
})
export const SetTitle = Schema.Struct({
  op: Schema.Literal("set-title"),
  title: Schema.NonEmptyTrimmedString,
})

export const DashboardEdit = Schema.Union(
  AddWidget,
  RemoveWidget,
  MoveWidget,
  ResizeWidget,
  UpdateWidget,
  SetTitle,
)
export type DashboardEdit = typeof DashboardEdit.Type

// ── Errors ────────────────────────────────────────────────────────────────────
export type EditError = { readonly _tag: "EditError"; readonly reason: string }
const err = (reason: string): Either.Either<never, EditError> =>
  Either.left({ _tag: "EditError", reason })

// ── Pure tree edits ─────────────────────────────────────────────────────────────
const leaf = (widget: Widget): LeafNode => ({ kind: "leaf", widget })

// Replace the leaf carrying `id` with `make(leaf)`; returns [node, found].
const transformLeaf = (
  node: LayoutNode,
  id: string,
  make: (l: LeafNode) => LayoutNode,
): readonly [LayoutNode, boolean] => {
  if (node.kind === "leaf") return node.widget.id === id ? [make(node), true] : [node, false]
  let found = false
  const children = node.children.map((c) => {
    if (found) return c
    const [next, f] = transformLeaf(c.node, id, make)
    if (f) found = true
    return f ? { ...c, node: next } : c
  })
  return [found ? { ...node, children } : node, found]
}

// Set the weight of the leaf `id` within its parent split; [node, found].
// Not found at a leaf root means the widget fills the screen — nothing to size against.
const setWeight = (
  node: LayoutNode,
  id: string,
  weight: number,
): readonly [LayoutNode, boolean] => {
  if (node.kind === "leaf") return [node, false]
  let found = false
  const children = node.children.map((c) => {
    if (found) return c
    if (c.node.kind === "leaf" && c.node.widget.id === id) {
      found = true
      return { ...c, weight }
    }
    const [next, f] = setWeight(c.node, id, weight)
    if (f) found = true
    return f ? { ...c, node: next } : c
  })
  return [found ? { ...node, children } : node, found]
}

// Remove the leaf `id`; collapse any split left with one child; null = subtree empty.
const removeLeaf = (node: LayoutNode, id: string): LayoutNode | null => {
  if (node.kind === "leaf") return node.widget.id === id ? null : node
  const children = node.children
    .map((c) => ({ ...c, node: removeLeaf(c.node, id) }))
    .filter((c): c is SplitChild => c.node !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!.node // collapse redundant split
  return { ...node, children }
}

// Stack a node above/below the whole current root.
const stackRoot = (root: LayoutNode, node: LayoutNode, side: "top" | "bottom"): LayoutNode => {
  const fresh: SplitChild = { weight: 1, node }
  if (root.kind === "split" && root.axis === "column")
    return {
      ...root,
      children: side === "top" ? [fresh, ...root.children] : [...root.children, fresh],
    }
  const existing: SplitChild = { weight: 1, node: root }
  return {
    kind: "split",
    axis: "column",
    children: side === "top" ? [fresh, existing] : [existing, fresh],
  }
}

// Insert `node` into `base` at `placement`.
const insertAt = (
  base: LayoutNode,
  node: LayoutNode,
  placement: Placement,
): Either.Either<LayoutNode, EditError> => {
  if (placement === "top") return Either.right(stackRoot(base, node, "top"))
  if (placement === "bottom") return Either.right(stackRoot(base, node, "bottom"))
  const { besideWidget, axis, side } = placement
  const [next, found] = transformLeaf(base, besideWidget, (target) => ({
    kind: "split",
    axis,
    children:
      side === "before"
        ? [{ weight: 1, node }, { weight: 1, node: target }]
        : [{ weight: 1, node: target }, { weight: 1, node }],
  }))
  return found ? Either.right(next) : err(`cannot place beside unknown widget "${besideWidget}"`)
}

// ── The reducer — pure, atomic, loud ────────────────────────────────────────────
export const applyEdit = (
  doc: DashboardDocument,
  edit: DashboardEdit,
): Either.Either<DashboardDocument, EditError> => {
  const candidate: Either.Either<DashboardDocument, EditError> = Either.gen(function* () {
    switch (edit.op) {
      case "set-title":
        return { ...doc, title: edit.title }

      case "update-widget": {
        const [layout, found] = transformLeaf(doc.layout, edit.widget.id, () => leaf(edit.widget))
        if (!found) return yield* err(`widget "${edit.widget.id}" not found`)
        return { ...doc, layout }
      }

      case "resize-widget": {
        const [layout, found] = setWeight(doc.layout, edit.widgetId, edit.weight)
        if (!found)
          return yield* err(
            `cannot resize "${edit.widgetId}" — not found, or it is the sole root widget`,
          )
        return { ...doc, layout }
      }

      case "remove-widget": {
        if (!widgetIds(doc.layout).includes(edit.widgetId))
          return yield* err(`widget "${edit.widgetId}" not found`)
        if (widgetIds(doc.layout).length === 1)
          return yield* err("cannot remove the last widget — a dashboard needs at least one")
        const layout = removeLeaf(doc.layout, edit.widgetId)!
        return { ...doc, layout }
      }

      case "add-widget": {
        if (widgetIds(doc.layout).includes(edit.widget.id))
          return yield* err(`widget "${edit.widget.id}" already exists`)
        const layout = yield* insertAt(doc.layout, leaf(edit.widget), edit.at)
        return { ...doc, layout }
      }

      case "move-widget": {
        const moved = findWidget(doc.layout, edit.widgetId)
        if (!moved) return yield* err(`widget "${edit.widgetId}" not found`)
        const removed = removeLeaf(doc.layout, edit.widgetId)
        const layout =
          removed === null ? leaf(moved) : yield* insertAt(removed, leaf(moved), edit.at)
        return { ...doc, layout }
      }
    }
  })

  // Gate 2: re-decode the resulting document. Never emit an un-revalidated doc.
  return Either.flatMap(candidate, (next) =>
    Either.mapLeft(Schema.decodeUnknownEither(DashboardDocument)(next), (e) => ({
      _tag: "EditError" as const,
      reason: `resulting document invalid: ${e.message}`,
    })),
  )
}

// ── The two entry points, one per editor ────────────────────────────────────────
// UI path: client holds a decoded doc, builds a typed edit; server STILL re-decodes.
export const applyTypedEdit = applyEdit

// Agent path: the tool gets UNTRUSTED JSON (an LLM wrote it). Gate 1 decodes the
// edit itself before anything touches the document.
export const applyRawEdit = (
  doc: DashboardDocument,
  rawEdit: unknown,
): Either.Either<DashboardDocument, EditError> =>
  Either.flatMap(
    Either.mapLeft(Schema.decodeUnknownEither(DashboardEdit)(rawEdit), (e) => ({
      _tag: "EditError" as const,
      reason: `rejected edit: ${e.message}`,
    })),
    (edit) => applyEdit(doc, edit),
  )

export const decodeDocument = Schema.decodeUnknownEither(DashboardDocument)
