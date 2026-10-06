import { layoutLeaves } from "./layout";
import { Effect, BigInt as EffectBigInt, Option, Schema, SchemaIssue } from "effect";
import {
  type Axis,
  type BesidePlacement,
  DashboardDocument,
  type DashboardEdit,
  type DashboardFailure,
  type DashboardIssue,
  DuplicateWidgetId,
  InvalidDashboardResult,
  LastWidgetRemoval,
  type LayoutNode,
  type LayoutRegionRatio,
  type LayoutRegionSelector,
  type Placement,
  RegionNotFound,
  RootRegionResize,
  SelfPlacement,
  type SplitNode,
  SplitWeight,
  type Widget,
  type WidgetId,
  WidgetNotFound,
  isBesidePlacement,
  maximumSplitWeight,
  minimumSplitWeight,
} from "~/core/dashboard/contract";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type StandardIssue = ReturnType<typeof formatIssues>["issues"][number];

/** An issue with no path names the document itself rather than one of its fields. */
const toDashboardIssue = (issue: StandardIssue): DashboardIssue => ({
  path:
    Option.getOrThrow(Option.fromNullishOr(issue.path)).length === 0
      ? Option.none()
      : Option.some(Option.getOrThrow(Option.fromNullishOr(issue.path)).map(String).join(".")),
  message: issue.message,
});

// The formatter flattens a failure into its leaves, and a real failure always
// has at least one; the fallback still reports the error itself rather than a
// fixed blurb if a formatter ever violates that invariant.
const toInvalidDashboardResult = (error: Schema.SchemaError): InvalidDashboardResult => {
  const [issue = { path: Option.none(), message: error.message }, ...rest] = formatIssues(
    error.issue
  ).issues.map(toDashboardIssue);
  return new InvalidDashboardResult({ issues: [issue, ...rest] });
};

// Only Type-side checks need re-proving after an edit, so this decodes the Type
// schema rather than round-tripping through the encoded form. `errors: "all"`
// is what makes the API's "correct every reported field" instruction true.
/** Re-prove all decoded document invariants and return field issues for the complete invalid result. */
export const revalidateDocument = (
  candidate: Readonly<DashboardDocument>
): Effect.Effect<DashboardDocument, InvalidDashboardResult> =>
  Schema.decodeEffect(Schema.toType(DashboardDocument), { errors: "all" })(candidate).pipe(
    Effect.mapError(toInvalidDashboardResult)
  );

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

type SplitChild = Readonly<SplitNode["children"][number]>;

type WeightedLayoutNode = Readonly<{ node: LayoutNode; weight: bigint }>;

type Expansion = ReadonlyArray<WeightedLayoutNode>;

/** A split child beside the denominator its own child weights are stated against. */
type DenominatedChild = Readonly<{ child: SplitChild; denominator: bigint }>;

/** The parent's common denominator, and the factor that lifts a nested split's own weights. */
type ChildScale = Readonly<{ keep: bigint; flatten: bigint }>;

const splitWeightPrecision = 1000;

/** Converts a bounded three-decimal weight into an integer for exact normalization arithmetic. */
const splitWeightInteger = (weight: SplitChild["weight"]): bigint =>
  BigInt(Math.round(weight * splitWeightPrecision));

/** Restates one child against the parent's common denominator, flattening same-axis nesting. */
const expandChild = (child: SplitChild, axis: Axis, scale: ChildScale): Expansion => {
  switch (child.node.kind) {
    case "split":
      return child.node.axis === axis
        ? child.node.children.map((nested) => ({
            node: nested.node,
            weight:
              splitWeightInteger(child.weight) * splitWeightInteger(nested.weight) * scale.flatten,
          }))
        : [{ node: child.node, weight: splitWeightInteger(child.weight) * scale.keep }];
    case "leaf":
      return [{ node: child.node, weight: splitWeightInteger(child.weight) * scale.keep }];
  }
};

const normalizeSplit = (node: Readonly<SplitNode>): SplitNode => {
  const children = node.children;
  const weighted: ReadonlyArray<DenominatedChild> = children.map((child) => ({
    child,
    denominator:
      child.node.kind === "leaf"
        ? 1n
        : child.node.children.reduce((sum, nested) => sum + splitWeightInteger(nested.weight), 0n),
  }));
  const common = weighted.reduce((product, entry) => product * entry.denominator, 1n);
  const expanded = weighted.flatMap(({ child, denominator }) =>
    expandChild(child, node.axis, { keep: common, flatten: common / denominator })
  );
  const divisor = expanded.reduce((current, child) => EffectBigInt.gcd(current, child.weight), 0n);
  const expandedChildren: AtLeastTwo<WeightedLayoutNode> = [
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
    case "split":
      return layout.axis === "column" ? Option.some(layout) : Option.none();
    case "leaf":
      return Option.none();
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

/** Remove one existing Widget and collapse its empty region; reject removing the final Widget. */
export const applyRemove = (
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

/** Add a validated Widget at the decoded placement; reject duplicate identity unless moving the same Widget. */
export const applyAdd = ({
  document,
  edit,
  duplicatePolicy,
}: Readonly<{
  document: Readonly<DashboardDocument>;
  edit: Readonly<Extract<DashboardEdit, { readonly op: "add-widget" }>>;
  duplicatePolicy: DuplicatePolicy;
}>): Effect.Effect<DashboardDocument, DashboardFailure> => {
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

/** Replace one existing Widget while preserving its position; reject absence or an invalid complete document. */
export const applyUpdate = ({
  document,
  widget,
}: Readonly<{ document: Readonly<DashboardDocument>; widget: Readonly<Widget> }>): Effect.Effect<
  DashboardDocument,
  DashboardFailure
> => {
  const layout = replaceWidget(document.layout, widget);
  return Option.isSome(layout)
    ? revalidateDocument({ ...document, layout: layout.value })
    : Effect.fail(new WidgetNotFound({ widgetId: widget.id, role: "edit-target" }));
};

const regionMatches = (
  node: Readonly<LayoutNode>,
  widgetIds: Readonly<LayoutRegionSelector>
): boolean => {
  const regionWidgetIds = layoutLeaves(node).map(({ widget }) => widget.id);
  return (
    regionWidgetIds.length === widgetIds.length &&
    regionWidgetIds.every((widgetId, index) => widgetId === widgetIds[index])
  );
};

const ratioParts: Readonly<
  Record<LayoutRegionRatio, Readonly<{ numerator: number; denominator: number }>>
> = {
  "one-quarter": { numerator: 1, denominator: 4 },
  "one-third": { numerator: 1, denominator: 3 },
  "one-half": { numerator: 1, denominator: 2 },
  "two-thirds": { numerator: 2, denominator: 3 },
  "three-quarters": { numerator: 3, denominator: 4 },
};

const resizeChildren = (
  children: Readonly<SplitNode["children"]>,
  resizedIndex: number,
  size: Extract<DashboardEdit, { readonly op: "resize-region" }>["size"]
): SplitNode["children"] => {
  if (size.kind === "weight") {
    const adjacentIndex = resizedIndex < children.length - 1 ? resizedIndex + 1 : resizedIndex - 1;
    const resized = Option.getOrThrow(Option.fromUndefinedOr(children[resizedIndex]));
    const adjacent = Option.getOrThrow(Option.fromUndefinedOr(children[adjacentIndex]));
    const pairWeight = resized.weight + adjacent.weight;
    const resizedWeight = SplitWeight.make(
      Math.round(
        Math.min(
          maximumSplitWeight,
          pairWeight - minimumSplitWeight,
          Math.max(minimumSplitWeight, pairWeight - maximumSplitWeight, size.weight)
        ) * splitWeightPrecision
      ) / splitWeightPrecision
    );
    const adjacentWeight = SplitWeight.make(
      Math.round((pairWeight - resizedWeight) * splitWeightPrecision) / splitWeightPrecision
    );
    return mapAtLeastTwo(children, (child, index) => {
      if (index === resizedIndex) return { ...child, weight: resizedWeight };
      return index === adjacentIndex ? { ...child, weight: adjacentWeight } : child;
    });
  }
  const { numerator, denominator } = ratioParts[size.ratio];
  const siblingCount = children.length - 1;
  const targetWeight = Schema.decodeSync(SplitWeight)(numerator * siblingCount);
  const siblingWeight = Schema.decodeSync(SplitWeight)(denominator - numerator);
  return mapAtLeastTwo(children, (child, index) => ({
    ...child,
    weight: index === resizedIndex ? targetWeight : siblingWeight,
  }));
};

const resizeRegion = (
  node: Readonly<LayoutNode>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "resize-region" }>>
): Option.Option<LayoutNode> => {
  if (node.kind === "leaf") return Option.none();
  for (const [index, child] of node.children.entries()) {
    if (regionMatches(child.node, edit.widgetIds)) {
      return Option.some({
        ...node,
        children: resizeChildren(node.children, index, edit.size),
      });
    }
    const replacement = resizeRegion(child.node, edit);
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

const resizeResult = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "resize-region" }>>
): Effect.Effect<DashboardDocument, DashboardFailure> =>
  Option.match(resizeRegion(document.layout, edit), {
    onNone: () => Effect.fail(new RegionNotFound({ widgetIds: edit.widgetIds })),
    onSome: (layout) => revalidateDocument({ ...document, layout }),
  });

/** Resize an exact child region with validated weights; reject the root or an absent selector. */
export const applyResize = ({
  document,
  edit,
}: Readonly<{
  document: Readonly<DashboardDocument>;
  edit: Readonly<Extract<DashboardEdit, { readonly op: "resize-region" }>>;
}>): Effect.Effect<DashboardDocument, DashboardFailure> =>
  regionMatches(document.layout, edit.widgetIds)
    ? Effect.fail(new RootRegionResize({ widgetIds: edit.widgetIds }))
    : resizeResult(document, edit);

/** The sibling Widget a Placement names, when it names one rather than a document edge. */
const besideWidgetId = (at: Readonly<Placement>): Option.Option<WidgetId> =>
  Option.liftPredicate(at, isBesidePlacement).pipe(
    Option.map((beside: Readonly<BesidePlacement>) => beside.besideWidget)
  );

/** Move one existing Widget without changing its identity; reject self placement and invalid complete layouts. */
export const applyMove = ({
  document,
  edit,
}: Readonly<{
  document: Readonly<DashboardDocument>;
  edit: Readonly<Extract<DashboardEdit, { readonly op: "move-widget" }>>;
}>): Effect.Effect<DashboardDocument, DashboardFailure> => {
  const removal = removeWidget({ node: document.layout, widgetId: edit.widgetId });
  if (Option.isNone(removal)) {
    return Effect.fail(new WidgetNotFound({ widgetId: edit.widgetId, role: "edit-target" }));
  }
  if (Option.contains(besideWidgetId(edit.at), edit.widgetId)) {
    return Effect.fail(new SelfPlacement({ widgetId: edit.widgetId }));
  }
  if (Option.isNone(removal.value.layout)) {
    return revalidateDocument(document);
  }
  return applyAdd({
    document: { ...document, layout: removal.value.layout.value },
    edit: { op: "add-widget", widget: removal.value.widget, at: edit.at },
    duplicatePolicy: "allow",
  });
};

const widgetById = (layout: Readonly<LayoutNode>, widgetId: WidgetId): Option.Option<Widget> =>
  Option.fromUndefinedOr(layoutLeaves(layout).find(({ widget }) => widget.id === widgetId)?.widget);

const replaceSwappedWidgets = (
  layout: Readonly<LayoutNode>,
  first: Readonly<Widget>,
  second: Readonly<Widget>
): LayoutNode => {
  if (layout.kind === "leaf") {
    const replacements = new Map([
      [first.id, second],
      [second.id, first],
    ]);
    return Option.match(Option.fromUndefinedOr(replacements.get(layout.widget.id)), {
      onNone: () => layout,
      onSome: (widget) => ({ ...layout, widget }),
    });
  }
  return {
    ...layout,
    children: mapAtLeastTwo(layout.children, (child) => ({
      ...child,
      node: replaceSwappedWidgets(child.node, first, second),
    })),
  };
};

/** Exchange two distinct existing Widgets in place; reject absent targets or an invalid complete document. */
export const applySwap = ({
  document,
  edit,
}: Readonly<{
  document: Readonly<DashboardDocument>;
  edit: Readonly<Extract<DashboardEdit, { readonly op: "swap-widgets" }>>;
}>): Effect.Effect<DashboardDocument, DashboardFailure> => {
  if (edit.widgetId === edit.withWidgetId) {
    return Effect.fail(new SelfPlacement({ widgetId: edit.widgetId }));
  }
  const first = widgetById(document.layout, edit.widgetId);
  if (Option.isNone(first)) {
    return Effect.fail(new WidgetNotFound({ widgetId: edit.widgetId, role: "edit-target" }));
  }
  const second = widgetById(document.layout, edit.withWidgetId);
  if (Option.isNone(second)) {
    return Effect.fail(
      new WidgetNotFound({ widgetId: edit.withWidgetId, role: "placement-target" })
    );
  }
  return revalidateDocument({
    ...document,
    layout: replaceSwappedWidgets(document.layout, first.value, second.value),
  });
};
