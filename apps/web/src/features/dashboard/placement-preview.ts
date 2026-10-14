import { BigInt as EffectBigInt, Option } from "effect";
import { type DashboardEdit, type LayoutNodeFor, SplitWeight } from "@/transport/client";
import type { DashboardLayout, DashboardWidget, DashboardWidgetView } from "./presentation";

type PendingWidget = Readonly<{ kind: "pending-widget"; widget: DashboardWidget }>;
export type PlacementLayout = LayoutNodeFor<DashboardWidgetView | PendingWidget>;
type Leaf = Extract<PlacementLayout, { kind: "leaf" }>;
type Split = Extract<PlacementLayout, { kind: "split" }>;
type Child = Split["children"][number];
const weightPrecision = 1000;
const integerWeight = (weight: number): bigint => BigInt(Math.round(weight * weightPrecision));
const flattenSplit = (split: Split): Split => {
  const denominated = split.children.map((child) => ({
    child,
    denominator:
      child.node.kind === "split"
        ? child.node.children.reduce((sum, nested) => sum + integerWeight(nested.weight), 0n)
        : 1n,
  }));
  const common = denominated.reduce((product, { denominator }) => product * denominator, 1n);
  const expanded = denominated.flatMap(({ child, denominator }) =>
    child.node.kind === "split" && child.node.axis === split.axis
      ? child.node.children.map((nested) => ({
          node: nested.node,
          weight:
            integerWeight(child.weight) * integerWeight(nested.weight) * (common / denominator),
        }))
      : [{ node: child.node, weight: integerWeight(child.weight) * common }]
  );
  const divisor = expanded.reduce((gcd, child) => EffectBigInt.gcd(gcd, child.weight), 0n);
  if (expanded.some(({ weight }) => weight / divisor > 1000n)) return split;
  const [first, second, ...rest] = expanded;
  if (first === undefined || second === undefined) return split;
  const child = (value: typeof first): Child => ({
    node: value.node,
    weight: SplitWeight.make(Number(value.weight / divisor)),
  });
  return { ...split, children: [child(first), child(second), ...rest.map(child)] };
};
const find = (node: PlacementLayout, id: string): Option.Option<Leaf> => {
  if (node.kind === "leaf") return node.widget.widget.id === id ? Option.some(node) : Option.none();
  return Option.fromUndefinedOr(
    node.children.flatMap(({ node: child }) => Option.toArray(find(child, id)))[0]
  );
};
const map = (
  node: PlacementLayout,
  change: (leaf: Leaf) => PlacementLayout,
  flatten = false
): PlacementLayout => {
  if (node.kind === "leaf") return change(node);
  const child = (value: Child): Child => ({ ...value, node: map(value.node, change, flatten) });
  const [first, second, ...rest] = node.children;
  const split: Split = { ...node, children: [child(first), child(second), ...rest.map(child)] };
  return flatten ? flattenSplit(split) : split;
};
const remove = (node: PlacementLayout, id: string): Option.Option<PlacementLayout> => {
  if (node.kind === "leaf") return node.widget.widget.id === id ? Option.none() : Option.some(node);
  const children = node.children.flatMap((child) =>
    Option.toArray(
      Option.map(remove(child.node, id), (remaining) => ({ ...child, node: remaining }))
    )
  );
  const [first, second, ...rest] = children;
  if (first === undefined) return Option.none();
  return Option.some(
    second === undefined
      ? first.node
      : flattenSplit({ ...node, children: [first, second, ...rest] })
  );
};
const beside = (
  previous: PlacementLayout,
  added: Leaf,
  placement: Readonly<{ axis: Split["axis"]; before: boolean }>
): Split => {
  const oldChild = { weight: SplitWeight.make(1), node: previous };
  const newChild = { weight: SplitWeight.make(1), node: added };
  return {
    kind: "split",
    axis: placement.axis,
    children: placement.before ? [newChild, oldChild] : [oldChild, newChild],
  };
};
const insert = (
  layout: PlacementLayout,
  added: Leaf,
  at: Extract<DashboardEdit, { op: "add-widget" }>["at"]
): PlacementLayout => {
  if (at === "top" || at === "bottom") {
    if (layout.kind === "split" && layout.axis === "column") {
      const child = { weight: SplitWeight.make(1), node: added };
      return {
        ...layout,
        children: at === "top" ? [child, ...layout.children] : [...layout.children, child],
      };
    }
    return beside(layout, added, { axis: "column", before: at === "top" });
  }
  return map(
    layout,
    (leaf) =>
      leaf.widget.widget.id === at.besideWidget
        ? beside(leaf, added, { axis: at.axis, before: at.side === "before" })
        : leaf,
    true
  );
};
const projectSwap = (
  layout: DashboardLayout,
  edit: Extract<DashboardEdit, { op: "swap-widgets" }>
): PlacementLayout => {
  const first = find(layout, edit.widgetId);
  const second = find(layout, edit.withWidgetId);
  if (Option.isNone(first) || Option.isNone(second)) return layout;
  return map(layout, (leaf) => {
    if (leaf.widget.widget.id === edit.widgetId) return second.value;
    return leaf.widget.widget.id === edit.withWidgetId ? first.value : leaf;
  });
};
const projectMove = (
  layout: DashboardLayout,
  edit: Extract<DashboardEdit, { op: "move-widget" }>
): PlacementLayout => {
  const source = find(layout, edit.widgetId);
  const remaining = remove(layout, edit.widgetId);
  return Option.isSome(source) && Option.isSome(remaining)
    ? insert(remaining.value, source.value, edit.at)
    : layout;
};
/** Financial results remain the last canonical read during placement previews. */
export const previewDashboardPlacement = ({
  layout,
  edit,
}: Readonly<{ layout: DashboardLayout; edit: DashboardEdit }>): PlacementLayout => {
  switch (edit.op) {
    case "swap-widgets":
      return projectSwap(layout, edit);
    case "move-widget":
      return projectMove(layout, edit);
    case "add-widget":
      return insert(
        layout,
        { kind: "leaf", widget: { kind: "pending-widget", widget: edit.widget } },
        edit.at
      );
    case "remove-widget":
    case "resize-region":
    case "set-title":
    case "update-widget":
      return layout;
  }
};
