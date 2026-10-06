import type { LayoutNode, LeafNode } from "~/core/dashboard/contract";

/** Traverse validated leaves in the order that defines mobile presentation. */
export const layoutLeaves = (node: Readonly<LayoutNode>): ReadonlyArray<LeafNode> =>
  node.kind === "leaf" ? [node] : node.children.flatMap((child) => layoutLeaves(child.node));
