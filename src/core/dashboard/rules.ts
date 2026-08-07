import { Effect, BigInt as EffectBigInt, Option, Schema } from "effect";
import {
  type DashboardFailure,
  type DashboardIssue,
  DuplicateWidgetId,
  InvalidDashboardResult,
  LastWidgetRemoval,
  RootWidgetResize,
  SelfPlacement,
  WidgetNotFound,
} from "./errors";
import {
  type Axis,
  type BesidePlacement,
  DashboardDocument,
  type DashboardEdit,
  type LayoutNode,
  type SplitNode,
  SplitWeight,
  type Widget,
  type WidgetId,
  findDashboardStructureIssue,
} from "./model";

const makeInvalidDashboardResult = (): InvalidDashboardResult => {
  const issues: [DashboardIssue] = [
    {
      path: Option.none(),
      message: "The edit produced a document outside DashboardDocument invariants",
    },
  ];
  return new InvalidDashboardResult({ issues });
};

const revalidateDocument = (
  candidate: Readonly<DashboardDocument>
): Effect.Effect<DashboardDocument, InvalidDashboardResult> => {
  const issue = findDashboardStructureIssue(candidate);
  if (Option.isSome(issue)) {
    return Effect.fail(
      new InvalidDashboardResult({
        issues: [{ path: Option.some(issue.value.path.join(".")), message: issue.value.issue }],
      })
    );
  }
  return Schema.encodeEffect(DashboardDocument)(candidate).pipe(
    Effect.flatMap(Schema.decodeEffect(DashboardDocument)),
    Effect.mapError(makeInvalidDashboardResult)
  );
};

type WidgetLookup = Readonly<{ readonly node: LayoutNode; readonly widgetId: WidgetId }>;

const hasLayoutWidget = (layout: Readonly<LayoutNode>, widgetId: WidgetId): boolean =>
  layout.kind === "leaf"
    ? layout.widget.id === widgetId
    : layout.children.some((child) => hasLayoutWidget(child.node, widgetId));

type AtLeastTwo<Value> = readonly [Value, Value, ...Array<Value>];

const mapAtLeastTwo = <Input, Output>(
  values: AtLeastTwo<Input>,
  mapValue: (value: Readonly<Input>, index: number) => Output
): AtLeastTwo<Output> => {
  const [first, second, ...remaining] = values;
  return [
    mapValue(first, 0),
    mapValue(second, 1),
    ...remaining.map((value, index) => mapValue(value, index + 2)),
  ];
};

type WeightedLayoutNode = Readonly<{ node: LayoutNode; weight: bigint }>;

/** Restates one child against the parent's common denominator, flattening same-axis nesting. */
const expandChild = (
  child: Readonly<SplitNode["children"][number]>,
  axis: Axis,
  scale: Readonly<{ readonly keep: bigint; readonly flatten: bigint }>
): ReadonlyArray<WeightedLayoutNode> => {
  switch (child.node.kind) {
    case "leaf":
      return [{ node: child.node, weight: BigInt(child.weight) * scale.keep }];
    case "split":
      return child.node.axis === axis
        ? child.node.children.map((nested) => ({
            node: nested.node,
            weight: BigInt(child.weight) * BigInt(nested.weight) * scale.flatten,
          }))
        : [{ node: child.node, weight: BigInt(child.weight) * scale.keep }];
  }
};

const normalizeSplit = (node: Readonly<SplitNode>): SplitNode => {
  const children = node.children;
  const weighted = children.map((child) => ({
    child,
    denominator:
      child.node.kind === "leaf"
        ? 1n
        : child.node.children.reduce((sum, nested) => sum + BigInt(nested.weight), 0n),
  }));
  const commonDenominator = weighted.reduce((product, entry) => product * entry.denominator, 1n);
  const expanded: ReadonlyArray<WeightedLayoutNode> = weighted.flatMap(({ child, denominator }) =>
    expandChild(child, node.axis, {
      keep: commonDenominator,
      flatten: commonDenominator / denominator,
    })
  );
  const divisor = expanded.reduce((current, child) => EffectBigInt.gcd(current, child.weight), 0n);
  const expandedChildren: AtLeastTwo<(typeof expanded)[number]> = [
    Option.getOrThrow(Option.fromUndefinedOr(expanded[0])),
    Option.getOrThrow(Option.fromUndefinedOr(expanded[1])),
    ...expanded.slice(2),
  ];
  const weights = mapAtLeastTwo(expandedChildren, (child) => child.weight / divisor);
  if (weights.some((weight) => weight > 1000n)) {
    return { ...node, children };
  }
  return {
    ...node,
    children: mapAtLeastTwo(expandedChildren, (child, index) => ({
      node: child.node,
      weight: SplitWeight.make(Number(weights[index])),
    })),
  };
};

const rootColumn = (layout: Readonly<LayoutNode>): Option.Option<Readonly<SplitNode>> => {
  switch (layout.kind) {
    case "leaf":
      return Option.none();
    case "split":
      return layout.axis === "column" ? Option.some(layout) : Option.none();
  }
};

const addAtRoot = (
  layout: Readonly<LayoutNode>,
  widget: Readonly<Widget>,
  at: "top" | "bottom"
): LayoutNode => {
  const child = {
    weight: SplitWeight.make(1),
    node: { kind: "leaf" as const, widget },
  };
  const column = rootColumn(layout);
  if (Option.isSome(column)) {
    return {
      ...column.value,
      children:
        at === "top" ? [child, ...column.value.children] : [...column.value.children, child],
    };
  }
  const previous = { weight: SplitWeight.make(1), node: layout };
  return {
    kind: "split",
    axis: "column",
    children: at === "top" ? [child, previous] : [previous, child],
  };
};

type BesideAddition = Readonly<{
  readonly duplicate: boolean;
  readonly layout: Option.Option<LayoutNode>;
}>;

type BesideInput = Readonly<{
  readonly widget: Widget;
  readonly placement: BesidePlacement;
  readonly checkDuplicate: boolean;
}>;

const addBesideLeaf = (
  layout: Readonly<Extract<LayoutNode, { readonly kind: "leaf" }>>,
  input: BesideInput
): BesideAddition => {
  const duplicate = input.checkDuplicate && layout.widget.id === input.widget.id;
  if (layout.widget.id !== input.placement.besideWidget) {
    return { duplicate, layout: Option.none() };
  }
  const previous = { weight: SplitWeight.make(1), node: layout };
  const added = {
    weight: SplitWeight.make(1),
    node: { kind: "leaf" as const, widget: input.widget },
  };
  return {
    duplicate,
    layout: Option.some({
      kind: "split",
      axis: input.placement.axis,
      children: input.placement.side === "before" ? [added, previous] : [previous, added],
    }),
  };
};

const addBesideWithoutDuplicateCheck = (
  layout: Readonly<SplitNode>,
  input: BesideInput
): BesideAddition => {
  for (const [index, child] of layout.children.entries()) {
    const addition = addBeside(child.node, input);
    if (Option.isNone(addition.layout)) continue;
    const addedLayout = addition.layout.value;
    const children = mapAtLeastTwo(layout.children, (current, childIndex) =>
      childIndex === index ? { ...current, node: addedLayout } : current
    );
    return {
      duplicate: input.checkDuplicate,
      layout: Option.some(normalizeSplit({ ...layout, children })),
    };
  }
  return { duplicate: input.checkDuplicate, layout: Option.none() };
};

const addBesideWithDuplicateCheck = (
  layout: Readonly<SplitNode>,
  input: BesideInput
): BesideAddition => {
  const additions = mapAtLeastTwo(layout.children, (child) => addBeside(child.node, input));
  let duplicate = false;
  for (const addition of additions) {
    duplicate ||= addition.duplicate;
  }
  for (const [replacementIndex, replacement] of additions.entries()) {
    if (Option.isNone(replacement.layout)) continue;
    const replacementLayout = replacement.layout.value;
    const children = mapAtLeastTwo(layout.children, (child, index) =>
      index === replacementIndex ? { ...child, node: replacementLayout } : child
    );
    return {
      duplicate,
      layout: Option.some(normalizeSplit({ ...layout, children })),
    };
  }
  return { duplicate, layout: Option.none() };
};

const addBeside = (layout: Readonly<LayoutNode>, input: BesideInput): BesideAddition => {
  if (layout.kind === "leaf") {
    return addBesideLeaf(layout, input);
  }
  return input.checkDuplicate
    ? addBesideWithDuplicateCheck(layout, input)
    : addBesideWithoutDuplicateCheck(layout, input);
};

type WidgetRemoval = Readonly<{
  readonly widget: Readonly<Widget>;
  readonly layout: Option.Option<Readonly<LayoutNode>>;
}>;

const collapseAfterChildRemoval = (
  node: Readonly<SplitNode>,
  children: ReadonlyArray<Readonly<SplitNode["children"][number]>>
): LayoutNode => {
  if (children.length === 1) {
    return Option.getOrThrow(Option.fromUndefinedOr(children[0])).node;
  }
  const first = Option.getOrThrow(Option.fromUndefinedOr(children[0]));
  const second = Option.getOrThrow(Option.fromUndefinedOr(children[1]));
  return normalizeSplit({ ...node, children: [first, second, ...children.slice(2)] });
};

const removeWidget = (input: WidgetLookup): Option.Option<WidgetRemoval> => {
  const { node, widgetId } = input;
  switch (node.kind) {
    case "leaf":
      return node.widget.id === widgetId
        ? Option.some({ widget: node.widget, layout: Option.none() })
        : Option.none();
    case "split":
      return removeSplitWidget(node, widgetId);
  }
};

const removeSplitWidget = (
  node: Readonly<SplitNode>,
  widgetId: WidgetId
): Option.Option<WidgetRemoval> => {
  for (const [index, child] of node.children.entries()) {
    const removal = removeWidget({ node: child.node, widgetId });
    if (Option.isNone(removal)) continue;
    const children = [...node.children];
    if (Option.isSome(removal.value.layout)) {
      children[index] = { ...child, node: removal.value.layout.value };
    } else {
      children.splice(index, 1);
    }
    return Option.some({
      widget: removal.value.widget,
      layout: Option.some(collapseAfterChildRemoval(node, children)),
    });
  }
  return Option.none();
};

const applyRemove = (
  input: Readonly<{
    readonly document: DashboardDocument;
    readonly widgetId: WidgetId;
  }>
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  const { document, widgetId } = input;
  const removal = removeWidget({ node: document.layout, widgetId });
  if (Option.isNone(removal)) {
    return Effect.fail(new WidgetNotFound({ widgetId, role: "edit-target" }));
  }
  return Option.match(removal.value.layout, {
    onNone: () => Effect.fail(new LastWidgetRemoval({ widgetId })),
    onSome: (layout) => revalidateDocument({ ...document, layout }),
  });
};

type DuplicatePolicy = "reject" | "allow";

const duplicatePolicies = new Set<DuplicatePolicy>(Array.of("reject"));

const applyAdd = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "add-widget" }>>,
  duplicatePolicy: DuplicatePolicy = "reject"
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  const shouldRejectDuplicate = duplicatePolicies.has(duplicatePolicy);
  if (typeof edit.at === "string") {
    if (shouldRejectDuplicate && hasLayoutWidget(document.layout, edit.widget.id)) {
      return Effect.fail(new DuplicateWidgetId({ widgetId: edit.widget.id }));
    }
    return revalidateDocument({
      ...document,
      layout: addAtRoot(document.layout, edit.widget, edit.at),
    });
  }
  const placement = edit.at;
  const addition = addBeside(document.layout, {
    widget: edit.widget,
    placement,
    checkDuplicate: shouldRejectDuplicate,
  });
  if (shouldRejectDuplicate && addition.duplicate) {
    return Effect.fail(new DuplicateWidgetId({ widgetId: edit.widget.id }));
  }
  return Option.match(addition.layout, {
    onNone: () =>
      Effect.fail(
        new WidgetNotFound({ widgetId: placement.besideWidget, role: "placement-target" })
      ),
    onSome: (layout) => revalidateDocument({ ...document, layout }),
  });
};

const replaceWidget = (
  layout: Readonly<LayoutNode>,
  widget: Readonly<Widget>
): Option.Option<LayoutNode> => {
  if (layout.kind === "leaf") {
    return layout.widget.id === widget.id ? Option.some({ ...layout, widget }) : Option.none();
  }
  for (const [index, child] of layout.children.entries()) {
    const replacement = replaceWidget(child.node, widget);
    if (Option.isSome(replacement)) {
      return Option.some({
        ...layout,
        children: mapAtLeastTwo(layout.children, (current, childIndex) =>
          childIndex === index ? { ...current, node: replacement.value } : current
        ),
      });
    }
  }
  return Option.none();
};

const applyUpdate = (
  document: Readonly<DashboardDocument>,
  widget: Readonly<Widget>
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  const layout = replaceWidget(document.layout, widget);
  return Option.isSome(layout)
    ? revalidateDocument({ ...document, layout: layout.value })
    : Effect.fail(new WidgetNotFound({ widgetId: widget.id, role: "edit-target" }));
};

const resizeWidget = (
  input: Readonly<{
    readonly node: LayoutNode;
    readonly widgetId: WidgetId;
    readonly weight: SplitWeight;
  }>
): Option.Option<LayoutNode> => {
  const { node, widgetId, weight } = input;
  if (node.kind === "leaf") {
    return Option.none();
  }
  for (const [index, child] of node.children.entries()) {
    if (child.node.kind === "leaf" && child.node.widget.id === widgetId) {
      return Option.some({
        ...node,
        children: mapAtLeastTwo(node.children, (current, childIndex) =>
          childIndex === index ? { ...current, weight } : current
        ),
      });
    }
    const replacement = resizeWidget({ node: child.node, widgetId, weight });
    if (Option.isSome(replacement)) {
      return Option.some({
        ...node,
        children: mapAtLeastTwo(node.children, (current, childIndex) =>
          childIndex === index ? { ...current, node: replacement.value } : current
        ),
      });
    }
  }
  return Option.none();
};

const applyResize = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "resize-widget" }>>
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  if (document.layout.kind === "leaf") {
    return document.layout.widget.id === edit.widgetId
      ? Effect.fail(new RootWidgetResize({ widgetId: edit.widgetId }))
      : Effect.fail(new WidgetNotFound({ widgetId: edit.widgetId, role: "edit-target" }));
  }
  const layout = resizeWidget({
    node: document.layout,
    widgetId: edit.widgetId,
    weight: edit.weight,
  });
  return Option.isSome(layout)
    ? revalidateDocument({ ...document, layout: layout.value })
    : Effect.fail(new WidgetNotFound({ widgetId: edit.widgetId, role: "edit-target" }));
};

const applyMove = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "move-widget" }>>
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  const removal = removeWidget({ node: document.layout, widgetId: edit.widgetId });
  if (Option.isNone(removal)) {
    return Effect.fail(new WidgetNotFound({ widgetId: edit.widgetId, role: "edit-target" }));
  }
  switch (edit.at) {
    case "top":
    case "bottom":
      break;
    default:
      if (edit.at.besideWidget === edit.widgetId) {
        return Effect.fail(new SelfPlacement({ widgetId: edit.widgetId }));
      }
  }
  if (Option.isNone(removal.value.layout)) {
    return revalidateDocument(document);
  }
  return applyAdd(
    { ...document, layout: removal.value.layout.value },
    { op: "add-widget", widget: removal.value.widget, at: edit.at },
    "allow"
  );
};

type ExistingWidgetEdit = Exclude<DashboardEdit, { readonly op: "set-title" | "add-widget" }>;

type PositionedWidgetEdit = Exclude<ExistingWidgetEdit, { readonly op: "remove-widget" }>;

type AppearanceEdit = Exclude<PositionedWidgetEdit, { readonly op: "move-widget" }>;

const applyAppearanceEdit = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<AppearanceEdit>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  edit.op === "resize-widget" ? applyResize(document, edit) : applyUpdate(document, edit.widget);

const applyPositionedWidgetEdit = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<PositionedWidgetEdit>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  edit.op === "move-widget" ? applyMove(document, edit) : applyAppearanceEdit(document, edit);

const applyExistingWidgetEdit = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<ExistingWidgetEdit>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  edit.op === "remove-widget"
    ? applyRemove({ document, widgetId: edit.widgetId })
    : applyPositionedWidgetEdit(document, edit);

const applyNonTitleEdit = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Exclude<DashboardEdit, { readonly op: "set-title" }>>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  edit.op === "add-widget" ? applyAdd(document, edit) : applyExistingWidgetEdit(document, edit);

/**
 * Applies one decoded UI-or-agent edit and re-proves the complete result.
 * Fails for absent targets, duplicate or self placement, removing the last Widget, resizing the
 * root Widget, or any edit whose complete result violates Dashboard invariants.
 */
export const applyDashboardEdit = (
  input: Readonly<{
    readonly document: DashboardDocument;
    readonly edit: DashboardEdit;
  }>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  input.edit.op === "set-title"
    ? revalidateDocument({ ...input.document, title: input.edit.title })
    : applyNonTitleEdit(input.document, input.edit);
