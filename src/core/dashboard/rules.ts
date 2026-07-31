import { Effect, Option, Schema } from "effect";
import {
  DuplicateWidgetId,
  InvalidDashboardResult,
  LastWidgetRemoval,
  RootWidgetResize,
  SelfPlacement,
  WidgetNotFound,
  type DashboardFailure,
} from "./errors";
import {
  DashboardDocument,
  findDashboardStructureIssue,
  SplitWeight,
  type BesidePlacement,
  type DashboardEdit,
  type LayoutNode,
  type SplitNode,
  type Widget,
  type WidgetId,
} from "./model";

const revalidateDocument = (
  candidate: Readonly<DashboardDocument>
): Effect.Effect<DashboardDocument, InvalidDashboardResult> => {
  const issue = findDashboardStructureIssue(candidate);
  if (issue !== undefined) {
    return Effect.fail(
      new InvalidDashboardResult({
        issues: [{ path: issue.path.join("."), message: issue.issue }],
      })
    );
  }
  return Schema.encodeEffect(DashboardDocument)(candidate).pipe(
    Effect.flatMap(Schema.decodeEffect(DashboardDocument)),
    Effect.mapError(
      () =>
        new InvalidDashboardResult({
          issues: [
            { message: "The edit produced a document outside DashboardDocument invariants" },
          ],
        })
    )
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

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const leastCommonMultiple = (left: bigint, right: bigint): bigint =>
  (left / greatestCommonDivisor(left, right)) * right;

const normalizeSplit = (node: Readonly<SplitNode>): SplitNode => {
  const children = node.children;
  const denominators = children.map((child) =>
    child.node.kind === "split" && child.node.axis === node.axis
      ? child.node.children.reduce((sum, nested) => sum + BigInt(nested.weight), 0n)
      : 1n
  );
  const commonDenominator = denominators.reduce(leastCommonMultiple, 1n);
  const expanded: ReadonlyArray<Readonly<{ node: LayoutNode; weight: bigint }>> = children.flatMap(
    (child, index) => {
      const denominator = denominators[index] ?? 1n;
      if (child.node.kind === "split" && child.node.axis === node.axis) {
        return child.node.children.map((nested) => ({
          node: nested.node,
          weight: BigInt(child.weight) * BigInt(nested.weight) * (commonDenominator / denominator),
        }));
      }
      return [{ node: child.node, weight: BigInt(child.weight) * commonDenominator }];
    }
  );
  const divisor = expanded.reduce(
    (current, child) => greatestCommonDivisor(current, child.weight),
    expanded[0]?.weight ?? 1n
  );
  const [first, second, ...remaining] = expanded;
  if (first === undefined || second === undefined) {
    return { ...node, children };
  }
  const expandedChildren: AtLeastTwo<(typeof expanded)[number]> = [first, second, ...remaining];
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

const addAtRoot = (
  layout: Readonly<LayoutNode>,
  widget: Readonly<Widget>,
  at: "top" | "bottom"
): LayoutNode => {
  const child = {
    weight: SplitWeight.make(1),
    node: { kind: "leaf" as const, widget },
  };
  if (layout.kind === "split" && layout.axis === "column") {
    return {
      ...layout,
      children: at === "top" ? [child, ...layout.children] : [...layout.children, child],
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
    if (Option.isSome(addition.layout)) {
      const addedLayout = addition.layout.value;
      const children = mapAtLeastTwo(layout.children, (current, childIndex) =>
        childIndex === index ? { ...current, node: addedLayout } : current
      );
      return { duplicate: false, layout: Option.some(normalizeSplit({ ...layout, children })) };
    }
  }
  return { duplicate: false, layout: Option.none() };
};

const addBesideWithDuplicateCheck = (
  layout: Readonly<SplitNode>,
  input: BesideInput
): BesideAddition => {
  const additions = mapAtLeastTwo(layout.children, (child) => addBeside(child.node, input));
  let duplicate = false;
  let replacementIndex = -1;
  for (const [index, addition] of additions.entries()) {
    duplicate ||= addition.duplicate;
    if (replacementIndex === -1 && Option.isSome(addition.layout)) {
      replacementIndex = index;
    }
  }
  const replacement = additions[replacementIndex];
  if (replacement === undefined || Option.isNone(replacement.layout)) {
    return { duplicate, layout: Option.none() };
  }
  const replacementLayout = replacement.layout.value;
  const children = mapAtLeastTwo(layout.children, (child, index) =>
    index === replacementIndex ? { ...child, node: replacementLayout } : child
  );
  return {
    duplicate,
    layout: Option.some(normalizeSplit({ ...layout, children })),
  };
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
): LayoutNode =>
  Option.fromUndefinedOr(children[1]).pipe(
    Option.match({
      onNone: () =>
        Option.fromUndefinedOr(children[0]).pipe(
          Option.map((child) => child.node),
          Option.getOrElse(() => node)
        ),
      onSome: (second) =>
        Option.fromUndefinedOr(children[0]).pipe(
          Option.map((first) =>
            normalizeSplit({ ...node, children: [first, second, ...children.slice(2)] })
          ),
          Option.getOrElse(() => node)
        ),
    })
  );

const removeWidget = (input: WidgetLookup): Option.Option<WidgetRemoval> => {
  const { node, widgetId } = input;
  if (node.kind === "leaf") {
    return node.widget.id === widgetId
      ? Option.some({ widget: node.widget, layout: Option.none() })
      : Option.none();
  }
  for (const [index, child] of node.children.entries()) {
    const removal = removeWidget({ node: child.node, widgetId });
    if (Option.isNone(removal)) {
      continue;
    }
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

const applyAdd = (
  document: Readonly<DashboardDocument>,
  edit: Readonly<Extract<DashboardEdit, { readonly op: "add-widget" }>>,
  rejectDuplicate = true
): Effect.Effect<DashboardDocument, DashboardFailure> => {
  if (typeof edit.at === "string") {
    if (rejectDuplicate && hasLayoutWidget(document.layout, edit.widget.id)) {
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
    checkDuplicate: rejectDuplicate,
  });
  if (rejectDuplicate && addition.duplicate) {
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
  if (typeof edit.at !== "string" && edit.at.besideWidget === edit.widgetId) {
    return Effect.fail(new SelfPlacement({ widgetId: edit.widgetId }));
  }
  if (Option.isNone(removal.value.layout)) {
    return revalidateDocument(document);
  }
  return applyAdd(
    { ...document, layout: removal.value.layout.value },
    { op: "add-widget", widget: removal.value.widget, at: edit.at },
    false
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
