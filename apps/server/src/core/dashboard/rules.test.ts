import { expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { RegionNotFound, RootRegionResize } from "./errors";
import {
  DashboardDocument,
  DashboardEdit,
  LayoutRegionSelector,
  type Widget,
  collectLayoutWidgets,
} from "./model";
import { applyDashboardEdit } from "./rules";

const document = Schema.decodeSync(DashboardDocument)({
  title: "Mi tablero",
  layout: {
    kind: "leaf",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000401",
      type: "spending-chart",
      groupBy: "category",
      period: "this-month",
    },
  },
});

type WidgetInput = typeof Widget.Encoded;
type WeightedWidget = Readonly<{
  readonly weight: number;
  readonly widget: WidgetInput;
}>;

const transactionListWidget = (id: string): WidgetInput => ({
  id,
  type: "transaction-list",
  limit: 10,
});

const customMetricWidget = (id: string): WidgetInput => ({
  id,
  type: "custom-metric",
  label: "Salidas",
  aggregation: "sum",
  period: "this-month",
});

const makeSplitDocument = (
  children: ReadonlyArray<WeightedWidget>,
  axis: "row" | "column" = "row"
): DashboardDocument =>
  Schema.decodeUnknownSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "split",
      axis,
      children: children.map(({ weight, widget }) => ({
        weight,
        node: { kind: "leaf", widget },
      })),
    },
  });

const makeNestedDocument = (): DashboardDocument =>
  Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: 1,
          node: {
            kind: "leaf",
            widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000461"),
          },
        },
        {
          weight: 1,
          node: {
            kind: "split",
            axis: "column",
            children: [
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000462"),
                },
              },
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000463"),
                },
              },
            ],
          },
        },
      ],
    },
  });

it("sets the dashboard's visible heading through the shared edit vocabulary", () => {
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "set-title",
    title: "Flujo de caja",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated.title).toBe("Flujo de caja");
  expect(updated.layout).toEqual(document.layout);
});

it("reports schema failures when an edit revalidates malformed document data", () => {
  const malformedDocument = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "leaf",
      widget: {
        id: "f1d1a000-0000-4000-8000-000000000490",
        type: "spending-chart",
        groupBy: "category",
        period: "this-month",
      },
    },
  });
  if (malformedDocument.layout.kind !== "leaf") throw new Error("Expected a leaf layout");
  Object.assign(malformedDocument.layout.widget, { type: "not-a-dashboard-widget" });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "set-title",
    title: "Flujo de caja",
  });

  const outcome = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: malformedDocument, edit }))
  );

  expect(Result.isFailure(outcome) ? outcome.failure : undefined).toMatchObject({
    _tag: "InvalidDashboardResult",
    issues: [{ path: Option.some("layout.widget") }],
  });
});

it("reports every malformed field when revalidating a moved root Widget", () => {
  const malformedDocument = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "leaf",
      widget: {
        id: "f1d1a000-0000-4000-8000-000000000491",
        type: "spending-chart",
        groupBy: "category",
        period: "this-month",
      },
    },
  });
  if (malformedDocument.layout.kind !== "leaf") throw new Error("Expected a leaf layout");
  Object.assign(malformedDocument, { title: "" });
  Object.assign(malformedDocument.layout.widget, { type: "not-a-dashboard-widget" });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000491",
    at: "bottom",
  });

  const outcome = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: malformedDocument, edit }))
  );

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure._tag).toBe("InvalidDashboardResult");
    if (outcome.failure._tag === "InvalidDashboardResult") {
      expect(outcome.failure.issues.map(({ path }) => path)).toEqual([
        Option.some("title"),
        Option.some("layout.widget"),
      ]);
    }
  }
});

it("preserves string and numeric segments in a nested validation path", () => {
  const malformedDocument = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "leaf",
      widget: {
        id: "f1d1a000-0000-4000-8000-000000000492",
        type: "spending-chart",
        groupBy: "category",
        period: "this-month",
      },
    },
  });
  if (malformedDocument.layout.kind !== "leaf") throw new Error("Expected a leaf layout");
  Object.assign(malformedDocument.layout.widget, { categories: ["not-a-category-id"] });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "set-title",
    title: "Flujo de caja",
  });

  const outcome = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: malformedDocument, edit }))
  );

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure._tag).toBe("InvalidDashboardResult");
    if (outcome.failure._tag === "InvalidDashboardResult") {
      expect(outcome.failure.issues[0].path).toEqual(Option.some("layout.widget.categories.0"));
    }
  }
});

it("reports a root schema failure without inventing a field path", () => {
  const malformedDocument: DashboardDocument = Object.assign(() => undefined, {
    title: document.title,
    layout: document.layout,
  });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000401",
    at: "bottom",
  });

  const outcome = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: malformedDocument, edit }))
  );

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure._tag).toBe("InvalidDashboardResult");
    if (outcome.failure._tag === "InvalidDashboardResult") {
      expect(outcome.failure.issues[0].path).toEqual(Option.none());
    }
  }
});

it("adds a widget at the top of the whole dashboard in mobile reading order", () => {
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000402",
      type: "transaction-list",
      limit: 10,
    },
    at: "top",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.axis).toBe("column");
    expect(
      updated.layout.children.map((child) => child.node.kind === "leaf" && child.node.widget.id)
    ).toEqual(["f1d1a000-0000-4000-8000-000000000402", "f1d1a000-0000-4000-8000-000000000401"]);
  }
});

it("rejects adding a duplicate WidgetId without changing the document", () => {
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000401",
      type: "transaction-list",
      limit: 10,
    },
    at: "bottom",
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("DuplicateWidgetId");
  expect(document.layout.kind).toBe("leaf");
});

it("distinguishes a missing placement target from a missing edit target", () => {
  const missingId = "f1d1a000-0000-4000-8000-000000000499";
  const placementEdit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000402",
      type: "transaction-list",
      limit: 10,
    },
    at: { besideWidget: missingId, axis: "row", side: "after" },
  });
  const targetEdit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: missingId,
  });

  const placement = Effect.runSync(
    Effect.result(applyDashboardEdit({ document, edit: placementEdit }))
  );
  const target = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit: targetEdit })));

  expect(Result.isFailure(placement) ? placement.failure : undefined).toMatchObject({
    _tag: "WidgetNotFound",
    role: "placement-target",
  });
  expect(Result.isFailure(target) ? target.failure : undefined).toMatchObject({
    _tag: "WidgetNotFound",
    role: "edit-target",
  });
});

it("normalizes a same-axis insertion while preserving the target region's share", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000411";
  const siblingId = "f1d1a000-0000-4000-8000-000000000412";
  const source = makeSplitDocument([
    { weight: 3, widget: customMetricWidget(targetId) },
    { weight: 2, widget: transactionListWidget(siblingId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000413",
      type: "budget-bar",
      categoryId: "10000000-0000-4000-8000-000000000001",
      currency: "COP",
    },
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.children.map((child) => child.weight)).toEqual([3, 3, 4]);
    expect(updated.layout.children.every((child) => child.node.kind === "leaf")).toBe(true);
  }
});

it("returns a typed failure when exact normalized ratios exceed the weight bound", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000414";
  const source = makeSplitDocument([
    { weight: 999, widget: transactionListWidget(targetId) },
    {
      weight: 1000,
      widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000415"),
    },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000416"),
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document: source, edit })));

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure._tag).toBe("InvalidDashboardResult");
    if (outcome.failure._tag === "InvalidDashboardResult") {
      expect(outcome.failure.issues).toEqual([
        {
          path: Option.some("layout.children.0.node.axis"),
          message: "Expected canonical layout without nested splits on the same axis",
        },
      ]);
    }
  }
});

it("accepts an exact normalized weight of 1000 at the upper boundary", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000417";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(targetId) },
    {
      weight: 500,
      widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000418"),
    },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000419"),
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([1, 1, 1000]);
});

it("reduces same-axis insertion weights to their smallest exact integer ratio", () => {
  const targetId = "f1d1a000-0000-4000-8000-00000000041a";
  const source = makeSplitDocument([
    { weight: 2, widget: transactionListWidget(targetId) },
    {
      weight: 2,
      widget: transactionListWidget("f1d1a000-0000-4000-8000-00000000041b"),
    },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-00000000041c"),
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([1, 1, 2]);
});

it("flattens only matching-axis regions and preserves a perpendicular sibling split", () => {
  const targetId = "f1d1a000-0000-4000-8000-00000000041d";
  const columnFirstId = "f1d1a000-0000-4000-8000-00000000041e";
  const columnSecondId = "f1d1a000-0000-4000-8000-00000000041f";
  const addedId = "f1d1a000-0000-4000-8000-000000000420";
  const source = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        { weight: 3, node: { kind: "leaf", widget: transactionListWidget(targetId) } },
        {
          weight: 2,
          node: {
            kind: "split",
            axis: "column",
            children: [
              {
                weight: 1,
                node: { kind: "leaf", widget: transactionListWidget(columnFirstId) },
              },
              {
                weight: 2,
                node: { kind: "leaf", widget: transactionListWidget(columnSecondId) },
              },
            ],
          },
        },
      ],
    },
  });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(addedId),
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.children.map(({ weight }) => weight)).toEqual([3, 3, 4]);
    expect(updated.layout.children.map(({ node }) => node.kind)).toEqual(["leaf", "leaf", "split"]);
    const perpendicular = updated.layout.children[2]?.node;
    expect(perpendicular).toMatchObject({ kind: "split", axis: "column" });
    if (perpendicular?.kind === "split") {
      expect(perpendicular.children.map(({ weight }) => weight)).toEqual([1, 2]);
    }
  }
  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    targetId,
    addedId,
    columnFirstId,
    columnSecondId,
  ]);
});

it("keeps a perpendicular parent while placing beside a nested widget", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000427";
  const siblingId = "f1d1a000-0000-4000-8000-000000000428";
  const outsideId = "f1d1a000-0000-4000-8000-000000000429";
  const addedId = "f1d1a000-0000-4000-8000-00000000042a";
  const source = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: 3,
          node: {
            kind: "split",
            axis: "column",
            children: [
              {
                weight: 2,
                node: { kind: "leaf", widget: transactionListWidget(targetId) },
              },
              {
                weight: 1,
                node: { kind: "leaf", widget: customMetricWidget(siblingId) },
              },
            ],
          },
        },
        {
          weight: 4,
          node: { kind: "leaf", widget: transactionListWidget(outsideId) },
        },
      ],
    },
  });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(addedId),
    at: { besideWidget: targetId, axis: "row", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.children.map(({ weight }) => weight)).toEqual([3, 4]);
    const nested = updated.layout.children[0].node;
    expect(nested).toMatchObject({ kind: "split", axis: "column" });
    if (nested.kind === "split") {
      expect(nested.children.map(({ weight }) => weight)).toEqual([2, 1]);
      expect(nested.children[0].node).toMatchObject({ kind: "split", axis: "row" });
    }
  }
  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    targetId,
    addedId,
    siblingId,
    outsideId,
  ]);
});

it("removes a widget and collapses the single-child split it leaves behind", () => {
  const removableId = "f1d1a000-0000-4000-8000-000000000421";
  const retainedId = "f1d1a000-0000-4000-8000-000000000422";
  const source = makeSplitDocument([
    { weight: 1, widget: customMetricWidget(removableId) },
    { weight: 1, widget: transactionListWidget(retainedId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: removableId,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("leaf");
  if (updated.layout.kind === "leaf") {
    expect(updated.layout.widget.id).toBe(retainedId);
  }
});

it("returns an actionable path when an edit exceeds a complete-document limit", () => {
  const source = makeSplitDocument(
    Array.from({ length: 24 }, (_, index) => ({
      weight: 1,
      widget: transactionListWidget(
        `f1d1a000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
      ),
    }))
  );
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000499"),
    at: "bottom",
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document: source, edit })));

  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure._tag).toBe("InvalidDashboardResult");
    if (outcome.failure._tag === "InvalidDashboardResult") {
      expect(Option.getOrElse(outcome.failure.issues[0].path, () => "")).toContain(
        "layout.children"
      );
    }
  }
});

it("refuses to remove the dashboard's last widget", () => {
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000401",
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("LastWidgetRemoval");
});

it("moves a widget by removing and structurally placing the same identity", () => {
  const movingId = "f1d1a000-0000-4000-8000-000000000431";
  const targetId = "f1d1a000-0000-4000-8000-000000000432";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(movingId) },
    { weight: 1, widget: customMetricWidget(targetId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: { besideWidget: targetId, axis: "column", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.axis).toBe("column");
    expect(
      updated.layout.children.map((child) => child.node.kind === "leaf" && child.node.widget.id)
    ).toEqual([targetId, movingId]);
  }
});

it("swaps two Widgets without changing the recursive layout topology", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000461";
  const secondId = "f1d1a000-0000-4000-8000-000000000463";
  const source = makeNestedDocument();
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "swap-widgets",
    widgetId: firstId,
    withWidgetId: secondId,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    secondId,
    "f1d1a000-0000-4000-8000-000000000462",
    firstId,
  ]);
  expect(updated.layout.kind === "split" ? updated.layout.axis : undefined).toBe("row");
});

it("rejects moving a widget beside itself without changing the input document", () => {
  const widgetId = "f1d1a000-0000-4000-8000-000000000401";
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId,
    at: { besideWidget: widgetId, axis: "row", side: "after" },
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("SelfPlacement");
  expect(document.layout.kind).toBe("leaf");
});

it("moves a widget to either root edge while preserving the requested order", () => {
  const movingId = "f1d1a000-0000-4000-8000-000000000425";
  const retainedId = "f1d1a000-0000-4000-8000-000000000426";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(movingId) },
    { weight: 1, widget: customMetricWidget(retainedId) },
  ]);
  const topEdit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: "top",
  });
  const bottomEdit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: "bottom",
  });

  const top = Effect.runSync(applyDashboardEdit({ document: source, edit: topEdit }));
  const bottom = Effect.runSync(applyDashboardEdit({ document: source, edit: bottomEdit }));

  expect(collectLayoutWidgets(top.layout).map(({ id }) => id)).toEqual([movingId, retainedId]);
  expect(collectLayoutWidgets(bottom.layout).map(({ id }) => id)).toEqual([retainedId, movingId]);
});

it("continuously resizes a leaf region identified by its exact Widget contents", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000441";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(targetId) },
    {
      weight: 1,
      widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000442"),
    },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds: [targetId],
    size: { kind: "weight", weight: 1.375 },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([1.375, 0.625]);
});

it("resizes only the selected boundary between adjacent regions", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000442";
  const source = makeSplitDocument([
    {
      weight: 1,
      widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000441"),
    },
    { weight: 1, widget: customMetricWidget(targetId) },
    {
      weight: 1,
      widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000443"),
    },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds: [targetId],
    size: { kind: "weight", weight: 1.5 },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([1, 1.5, 0.5]);
});

it.each([
  [
    "move-widget",
    {
      op: "move-widget",
      widgetId: "f1d1a000-0000-4000-8000-000000000462",
      at: {
        besideWidget: "f1d1a000-0000-4000-8000-000000000461",
        axis: "column",
        side: "after",
      },
    },
    [
      "f1d1a000-0000-4000-8000-000000000461",
      "f1d1a000-0000-4000-8000-000000000462",
      "f1d1a000-0000-4000-8000-000000000463",
    ],
  ],
  [
    "remove-widget",
    { op: "remove-widget", widgetId: "f1d1a000-0000-4000-8000-000000000462" },
    ["f1d1a000-0000-4000-8000-000000000461", "f1d1a000-0000-4000-8000-000000000463"],
  ],
] as const)("normalizes decimal weights while applying %s", (_operation, input, expectedIds) => {
  const resize = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds: ["f1d1a000-0000-4000-8000-000000000462", "f1d1a000-0000-4000-8000-000000000463"],
    size: { kind: "weight", weight: 1.375 },
  });
  const resized = Effect.runSync(
    applyDashboardEdit({ document: makeNestedDocument(), edit: resize })
  );
  const edit = Schema.decodeSync(DashboardEdit)(input);

  const updated = Effect.runSync(applyDashboardEdit({ document: resized, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual(expectedIds);
});

it.each([
  ["one-quarter", [2, 3, 3]],
  ["one-third", [2, 2, 2]],
  ["one-half", [2, 1, 1]],
  ["two-thirds", [4, 1, 1]],
  ["three-quarters", [6, 1, 1]],
] as const)(
  "applies the exact %s ratio regardless of current sibling weights",
  (ratio, weights) => {
    const targetId = "f1d1a000-0000-4000-8000-000000000443";
    const source = makeSplitDocument([
      { weight: 1, widget: transactionListWidget(targetId) },
      { weight: 999, widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000444") },
      { weight: 1, widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000445") },
    ]);
    const edit = Schema.decodeSync(DashboardEdit)({
      op: "resize-region",
      widgetIds: [targetId],
      size: { kind: "ratio", ratio },
    });

    const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

    expect(
      updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
    ).toEqual(weights);
  }
);

it("resizes a compound region through the same canonical edit", () => {
  const source = makeNestedDocument();
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds: ["f1d1a000-0000-4000-8000-000000000462", "f1d1a000-0000-4000-8000-000000000463"],
    size: { kind: "weight", weight: 4 },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([0.001, 1.999]);
});

it("rejects resizing the root region because it has no sibling-relative weight", () => {
  const widgetIds = Schema.decodeSync(LayoutRegionSelector)([
    "f1d1a000-0000-4000-8000-000000000401",
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds,
    size: { kind: "weight", weight: 2 },
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit })));

  expect(outcome).toEqual(Result.fail(new RootRegionResize({ widgetIds })));
});

it("wraps an existing row when adding a widget at the dashboard bottom", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000464";
  const secondId = "f1d1a000-0000-4000-8000-000000000465";
  const addedId = "f1d1a000-0000-4000-8000-000000000466";
  const source = makeSplitDocument([
    { weight: 2, widget: transactionListWidget(firstId) },
    { weight: 3, widget: customMetricWidget(secondId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(addedId),
    at: "bottom",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.axis).toBe("column");
    expect(updated.layout.children[0].node).toMatchObject({ kind: "split", axis: "row" });
    expect(updated.layout.children[1].node).toMatchObject({
      kind: "leaf",
      widget: { id: addedId },
    });
  }
  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    firstId,
    secondId,
    addedId,
  ]);
});

it("prepends a root widget to an existing column without introducing another split", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000468";
  const secondId = "f1d1a000-0000-4000-8000-000000000469";
  const addedId = "f1d1a000-0000-4000-8000-000000000470";
  const source = makeSplitDocument(
    [
      { weight: 2, widget: transactionListWidget(firstId) },
      { weight: 3, widget: customMetricWidget(secondId) },
    ],
    "column"
  );
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(addedId),
    at: "top",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split") {
    expect(updated.layout.axis).toBe("column");
    expect(updated.layout.children.map(({ weight }) => weight)).toEqual([1, 2, 3]);
  }
  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    addedId,
    firstId,
    secondId,
  ]);
});

it("appends a root widget to an existing column in mobile reading order", () => {
  const source = makeSplitDocument(
    [
      {
        weight: 1,
        widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000471"),
      },
      { weight: 1, widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000472") },
    ],
    "column"
  );
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000473"),
    at: "bottom",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    "f1d1a000-0000-4000-8000-000000000471",
    "f1d1a000-0000-4000-8000-000000000472",
    "f1d1a000-0000-4000-8000-000000000473",
  ]);
});

it("finds a duplicate nested in only one branch before a root insertion", () => {
  const duplicateId = "f1d1a000-0000-4000-8000-000000000463";
  const source = makeNestedDocument();
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(duplicateId),
    at: "bottom",
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document: source, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("DuplicateWidgetId");
});

it("reports a missing beside target after searching every split branch", () => {
  const source = makeNestedDocument();
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-00000000046b"),
    at: {
      besideWidget: "f1d1a000-0000-4000-8000-00000000046c",
      axis: "row",
      side: "after",
    },
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document: source, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure : undefined).toMatchObject({
    _tag: "WidgetNotFound",
    role: "placement-target",
  });
});

it("inserts before a later sibling and still checks the complete document for duplicates", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000474";
  const targetId = "f1d1a000-0000-4000-8000-000000000475";
  const duplicateId = "f1d1a000-0000-4000-8000-000000000476";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(firstId) },
    { weight: 1, widget: customMetricWidget(targetId) },
    { weight: 1, widget: transactionListWidget(duplicateId) },
  ]);
  const insert = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000477"),
    at: { besideWidget: targetId, axis: "row", side: "before" },
  });
  const duplicate = Schema.decodeSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(duplicateId),
    at: { besideWidget: firstId, axis: "column", side: "after" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit: insert }));
  const rejected = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: duplicate }))
  );

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    firstId,
    "f1d1a000-0000-4000-8000-000000000477",
    targetId,
    duplicateId,
  ]);
  expect(Result.isFailure(rejected) ? rejected.failure._tag : undefined).toBe("DuplicateWidgetId");
});

it("removes a later sibling without collapsing a split that still has two children", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000478";
  const removedId = "f1d1a000-0000-4000-8000-000000000479";
  const lastId = "f1d1a000-0000-4000-8000-00000000047a";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(firstId) },
    { weight: 1, widget: customMetricWidget(removedId) },
    { weight: 1, widget: transactionListWidget(lastId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: removedId,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([firstId, lastId]);
});

it("preserves exact weighted shares when removal exposes a same-axis split", () => {
  const removedId = "f1d1a000-0000-4000-8000-000000000485";
  const firstId = "f1d1a000-0000-4000-8000-000000000486";
  const secondId = "f1d1a000-0000-4000-8000-000000000487";
  const lastId = "f1d1a000-0000-4000-8000-000000000488";
  const source = Schema.decodeSync(DashboardDocument)({
    title: "Mi tablero",
    layout: {
      kind: "split",
      axis: "row",
      children: [
        {
          weight: 6,
          node: {
            kind: "split",
            axis: "column",
            children: [
              {
                weight: 1,
                node: { kind: "leaf", widget: transactionListWidget(removedId) },
              },
              {
                weight: 1,
                node: {
                  kind: "split",
                  axis: "row",
                  children: [
                    {
                      weight: 2,
                      node: { kind: "leaf", widget: transactionListWidget(firstId) },
                    },
                    {
                      weight: 3,
                      node: { kind: "leaf", widget: customMetricWidget(secondId) },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          weight: 4,
          node: { kind: "leaf", widget: transactionListWidget(lastId) },
        },
      ],
    },
  });
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: removedId,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    firstId,
    secondId,
    lastId,
  ]);
  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([6, 9, 10]);
});

it("collapses a nested split while retaining its parent region", () => {
  const source = makeNestedDocument();
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "remove-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000462",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    "f1d1a000-0000-4000-8000-000000000461",
    "f1d1a000-0000-4000-8000-000000000463",
  ]);
});

it("updates a later nested Widget and rejects an absent update target", () => {
  const source = makeNestedDocument();
  const targetId = "f1d1a000-0000-4000-8000-000000000463";
  const update = Schema.decodeSync(DashboardEdit)({
    op: "update-widget",
    widget: customMetricWidget(targetId),
  });
  const missing = Schema.decodeSync(DashboardEdit)({
    op: "update-widget",
    widget: customMetricWidget("f1d1a000-0000-4000-8000-00000000047b"),
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit: update }));
  const rejected = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: missing }))
  );

  expect(collectLayoutWidgets(updated.layout).find(({ id }) => id === targetId)?.type).toBe(
    "custom-metric"
  );
  expect(Result.isFailure(rejected) ? rejected.failure._tag : undefined).toBe("WidgetNotFound");
});

it("rejects stale region selectors without resizing a different region", () => {
  const source = makeNestedDocument();
  const widgetIds = Schema.decodeSync(LayoutRegionSelector)([
    "f1d1a000-0000-4000-8000-000000000461",
    "f1d1a000-0000-4000-8000-000000000463",
  ]);
  const stale = Schema.decodeSync(DashboardEdit)({
    op: "resize-region",
    widgetIds,
    size: { kind: "weight", weight: 4 },
  });

  const outcome = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: stale }))
  );

  expect(outcome).toEqual(Result.fail(new RegionNotFound({ widgetIds })));
  expect(
    source.layout.kind === "split" ? source.layout.children.map(({ weight }) => weight) : []
  ).toEqual([1, 1]);
});

it("moves through the no-duplicate-check branch and flattens the destination row", () => {
  const movingId = "f1d1a000-0000-4000-8000-000000000482";
  const targetId = "f1d1a000-0000-4000-8000-000000000483";
  const siblingId = "f1d1a000-0000-4000-8000-000000000484";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(movingId) },
    { weight: 3, widget: customMetricWidget(targetId) },
    { weight: 2, widget: transactionListWidget(siblingId) },
  ]);
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: { besideWidget: targetId, axis: "row", side: "before" },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    movingId,
    targetId,
    siblingId,
  ]);
  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([3, 3, 4]);
});

it("moves a later Widget in one traversal and reports both missing move targets", () => {
  const firstId = "f1d1a000-0000-4000-8000-00000000047e";
  const targetId = "f1d1a000-0000-4000-8000-00000000047f";
  const movingId = "f1d1a000-0000-4000-8000-000000000480";
  const missingId = "f1d1a000-0000-4000-8000-000000000481";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(firstId) },
    { weight: 1, widget: customMetricWidget(targetId) },
    { weight: 1, widget: transactionListWidget(movingId) },
  ]);
  const move = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: { besideWidget: targetId, axis: "column", side: "before" },
  });
  const missingPlacement = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: firstId,
    at: { besideWidget: missingId, axis: "column", side: "after" },
  });
  const missingTarget = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: missingId,
    at: "top",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit: move }));
  const placementFailure = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: missingPlacement }))
  );
  const targetFailure = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: missingTarget }))
  );

  expect(collectLayoutWidgets(updated.layout).map(({ id }) => id)).toEqual([
    firstId,
    movingId,
    targetId,
  ]);
  expect(Result.isFailure(placementFailure) ? placementFailure.failure : undefined).toMatchObject({
    _tag: "WidgetNotFound",
    role: "placement-target",
  });
  expect(Result.isFailure(targetFailure) ? targetFailure.failure : undefined).toMatchObject({
    _tag: "WidgetNotFound",
    role: "edit-target",
  });
});

it("treats moving the only root Widget to a root edge as an unchanged valid document", () => {
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "move-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000401",
    at: "bottom",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated).toEqual(document);
});

it("replaces the complete widget configuration while retaining its identity and region", () => {
  const widgetId = "f1d1a000-0000-4000-8000-000000000401";
  const edit = Schema.decodeSync(DashboardEdit)({
    op: "update-widget",
    widget: {
      id: widgetId,
      type: "budget-bar",
      title: "Presupuesto de restaurantes",
      categoryId: "10000000-0000-4000-8000-000000000001",
      currency: "COP",
    },
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated.layout.kind).toBe("leaf");
  if (updated.layout.kind === "leaf") {
    expect(updated.layout.widget).toMatchObject({
      id: widgetId,
      type: "budget-bar",
      currency: "COP",
    });
  }
});
