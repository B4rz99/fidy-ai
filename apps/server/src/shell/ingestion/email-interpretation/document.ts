import { Option } from "effect";
import { type DefaultTreeAdapterMap, defaultTreeAdapter, parse } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const maximumNodes = 4_000;
const maximumDepth = 64;
const maximumNormalizedText = 80_000;
const ignoredElements = new Set(["script", "template", "noscript"]);
const hiddenStyle =
  /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0)(?:\s*!important)?/iu;

type TraversalState = {
  nodes: number;
  cellNodes: number;
  overflow: boolean;
  unsafeVisibility: boolean;
};

type PendingNode = Readonly<{ node: Node; depth: number }>;

const exceedsTraversalBounds = (nodes: number, depth: number): boolean =>
  nodes > maximumNodes || depth > maximumDepth;

const hasUnsafeVisibility = (element: Element): boolean => {
  if (element.tagName === "style") {
    return true;
  }
  const attributes = defaultTreeAdapter.getAttrList(element);
  return attributes.some(
    ({ name, value }) =>
      name === "hidden" ||
      (name === "aria-hidden" && value.trim().toLowerCase() === "true") ||
      (name === "style" && hiddenStyle.test(value)) ||
      (element.tagName === "link" && name === "rel" && value.toLowerCase().includes("stylesheet"))
  );
};

/** One bounded, inert HTML projection shared by every notification format. */
export type EmailDocument = Readonly<{
  text: string;
  rows: ReadonlyArray<ReadonlyArray<string>>;
}>;

/** Canonicalizes decoded HTML text for structural matching, never for retained financial facts. */
export const normalizeDocumentText = (text: string): string =>
  text
    .normalize("NFKC")
    .replaceAll(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();

const appendChildren = (element: Element, depth: number, pending: Array<PendingNode>): void => {
  const children = defaultTreeAdapter.getChildNodes(element);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
};

type CellTextState = Readonly<{
  traversal: TraversalState;
  text: Array<string>;
  pending: Array<PendingNode>;
}>;

const inspectPendingNode = (current: PendingNode, state: CellTextState): void => {
  state.traversal.cellNodes += 1;
  if (exceedsTraversalBounds(state.traversal.cellNodes, current.depth)) {
    state.traversal.overflow = true;
    return;
  }
  if (defaultTreeAdapter.isTextNode(current.node)) {
    state.text.push(current.node.value);
    return;
  }
  if (!defaultTreeAdapter.isElementNode(current.node)) {
    return;
  }
  if (hasUnsafeVisibility(current.node)) {
    state.traversal.unsafeVisibility = true;
    return;
  }
  if (!ignoredElements.has(current.node.tagName)) {
    appendChildren(current.node, current.depth, state.pending);
  }
};

const boundedNodeText = (root: Node, rootDepth: number, traversal: TraversalState): string => {
  const text: Array<string> = [];
  const pending: Array<PendingNode> = [{ node: root, depth: rootDepth }];
  while (pending.length > 0 && !traversal.overflow) {
    const current = pending.pop();
    if (current !== undefined) {
      inspectPendingNode(current, { traversal, text, pending });
    }
  }
  return text.join(" ");
};

const directCells = (
  row: Element,
  depth: number,
  traversal: TraversalState
): ReadonlyArray<string> => {
  const cells = defaultTreeAdapter
    .getChildNodes(row)
    .filter((node) => defaultTreeAdapter.isElementNode(node))
    .filter((child) => child.tagName === "td" || child.tagName === "th");
  return cells.length === 2
    ? cells.map((cell) => normalizeDocumentText(boundedNodeText(cell, depth + 1, traversal)))
    : [];
};

/**
 * Parses bounded HTML without executing or fetching embedded content. Overflow and potentially
 * hidden content are absence, not truncation, because either could manufacture unique recognition.
 */
export const parseEmailDocument = (html: string): Option.Option<EmailDocument> => {
  const root = parse(html);
  const traversal: TraversalState = {
    nodes: 0,
    cellNodes: 0,
    overflow: false,
    unsafeVisibility: false,
  };
  const text: Array<string> = [];
  const rows: Array<ReadonlyArray<string>> = [];

  const visitElement = (element: Element, depth: number): void => {
    if (hasUnsafeVisibility(element)) {
      traversal.unsafeVisibility = true;
      return;
    }
    if (ignoredElements.has(element.tagName)) {
      return;
    }
    if (element.tagName === "tr") {
      const cells = directCells(element, depth, traversal);
      if (cells.length > 0) {
        rows.push(cells);
      }
    }
    for (const child of defaultTreeAdapter.getChildNodes(element)) {
      visit(child, depth + 1);
    }
  };
  const visit = (node: Node, depth: number): void => {
    traversal.nodes += 1;
    if (exceedsTraversalBounds(traversal.nodes, depth)) {
      traversal.overflow = true;
      return;
    }
    if (defaultTreeAdapter.isTextNode(node)) {
      text.push(node.value);
      return;
    }
    if (defaultTreeAdapter.isElementNode(node)) {
      visitElement(node, depth);
    }
  };

  for (const child of defaultTreeAdapter.getChildNodes(root)) {
    visit(child, 1);
  }
  const normalized = normalizeDocumentText(text.join(" "));
  const unsafe =
    traversal.overflow || traversal.unsafeVisibility || normalized.length > maximumNormalizedText;
  return unsafe ? Option.none() : Option.some({ text: normalized, rows });
};
