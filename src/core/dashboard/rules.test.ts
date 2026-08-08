import { expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { DashboardDocument, DashboardEdit, collectLayoutWidgets } from "./model";
import { applyDashboardEdit } from "./rules";

const document = Schema.decodeUnknownSync(DashboardDocument)({
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

type WeightedWidget = Readonly<{
  readonly weight: number;
  readonly widget: Readonly<Record<string, unknown>>;
}>;

const transactionListWidget = (id: string): Readonly<Record<string, unknown>> => ({
  id,
  type: "transaction-list",
  limit: 10,
});

const customMetricWidget = (id: string): Readonly<Record<string, unknown>> => ({
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
  Schema.decodeUnknownSync(DashboardDocument)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "set-title",
    title: "Flujo de caja",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated.title).toBe("Flujo de caja");
  expect(updated.layout).toEqual(document.layout);
});

it("reports schema failures when an edit revalidates malformed document data", () => {
  const malformedDocument = Schema.decodeUnknownSync(DashboardDocument)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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

it("adds a widget at the top of the whole dashboard in mobile reading order", () => {
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const placementEdit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "add-widget",
    widget: {
      id: "f1d1a000-0000-4000-8000-000000000402",
      type: "transaction-list",
      limit: 10,
    },
    at: { besideWidget: missingId, axis: "row", side: "after" },
  });
  const targetEdit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const source = Schema.decodeUnknownSync(DashboardDocument)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const source = Schema.decodeUnknownSync(DashboardDocument)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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

it("rejects moving a widget beside itself without changing the input document", () => {
  const widgetId = "f1d1a000-0000-4000-8000-000000000401";
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const topEdit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: "top",
  });
  const bottomEdit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: "bottom",
  });

  const top = Effect.runSync(applyDashboardEdit({ document: source, edit: topEdit }));
  const bottom = Effect.runSync(applyDashboardEdit({ document: source, edit: bottomEdit }));

  expect(collectLayoutWidgets(top.layout).map(({ id }) => id)).toEqual([movingId, retainedId]);
  expect(collectLayoutWidgets(bottom.layout).map(({ id }) => id)).toEqual([retainedId, movingId]);
});

it("resizes the immediate region containing a widget", () => {
  const targetId = "f1d1a000-0000-4000-8000-000000000441";
  const source = makeSplitDocument([
    { weight: 1, widget: transactionListWidget(targetId) },
    {
      weight: 1,
      widget: customMetricWidget("f1d1a000-0000-4000-8000-000000000442"),
    },
  ]);
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "resize-widget",
    widgetId: targetId,
    weight: 3,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit }));

  expect(
    updated.layout.kind === "split" ? updated.layout.children.map(({ weight }) => weight) : []
  ).toEqual([3, 1]);
});

it("rejects resizing the root widget because it has no sibling-relative weight", () => {
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "resize-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000401",
    weight: 2,
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("RootWidgetResize");
});

it("wraps an existing row when adding a widget at the dashboard bottom", () => {
  const firstId = "f1d1a000-0000-4000-8000-000000000464";
  const secondId = "f1d1a000-0000-4000-8000-000000000465";
  const addedId = "f1d1a000-0000-4000-8000-000000000466";
  const source = makeSplitDocument([
    { weight: 2, widget: transactionListWidget(firstId) },
    { weight: 3, widget: customMetricWidget(secondId) },
  ]);
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget(duplicateId),
    at: "bottom",
  });

  const outcome = Effect.runSync(Effect.result(applyDashboardEdit({ document: source, edit })));

  expect(Result.isFailure(outcome) ? outcome.failure._tag : undefined).toBe("DuplicateWidgetId");
});

it("reports a missing beside target after searching every split branch", () => {
  const source = makeNestedDocument();
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const insert = Schema.decodeUnknownSync(DashboardEdit)({
    op: "add-widget",
    widget: transactionListWidget("f1d1a000-0000-4000-8000-000000000477"),
    at: { besideWidget: targetId, axis: "row", side: "before" },
  });
  const duplicate = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const source = Schema.decodeUnknownSync(DashboardDocument)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const update = Schema.decodeUnknownSync(DashboardEdit)({
    op: "update-widget",
    widget: customMetricWidget(targetId),
  });
  const missing = Schema.decodeUnknownSync(DashboardEdit)({
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

it("resizes a nested region and distinguishes missing nested and root targets", () => {
  const source = makeNestedDocument();
  const resize = Schema.decodeUnknownSync(DashboardEdit)({
    op: "resize-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000463",
    weight: 4,
  });
  const missingNested = Schema.decodeUnknownSync(DashboardEdit)({
    op: "resize-widget",
    widgetId: "f1d1a000-0000-4000-8000-00000000047c",
    weight: 2,
  });
  const missingRoot = Schema.decodeUnknownSync(DashboardEdit)({
    op: "resize-widget",
    widgetId: "f1d1a000-0000-4000-8000-00000000047d",
    weight: 2,
  });

  const updated = Effect.runSync(applyDashboardEdit({ document: source, edit: resize }));
  const nestedFailure = Effect.runSync(
    Effect.result(applyDashboardEdit({ document: source, edit: missingNested }))
  );
  const rootFailure = Effect.runSync(
    Effect.result(applyDashboardEdit({ document, edit: missingRoot }))
  );

  expect(updated.layout.kind).toBe("split");
  if (updated.layout.kind === "split" && updated.layout.children[1].node.kind === "split") {
    expect(updated.layout.children[1].node.children.map(({ weight }) => weight)).toEqual([1, 4]);
  }
  expect(Result.isFailure(nestedFailure) ? nestedFailure.failure._tag : undefined).toBe(
    "WidgetNotFound"
  );
  expect(Result.isFailure(rootFailure) ? rootFailure.failure._tag : undefined).toBe(
    "WidgetNotFound"
  );
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
  const move = Schema.decodeUnknownSync(DashboardEdit)({
    op: "move-widget",
    widgetId: movingId,
    at: { besideWidget: targetId, axis: "column", side: "before" },
  });
  const missingPlacement = Schema.decodeUnknownSync(DashboardEdit)({
    op: "move-widget",
    widgetId: firstId,
    at: { besideWidget: missingId, axis: "column", side: "after" },
  });
  const missingTarget = Schema.decodeUnknownSync(DashboardEdit)({
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
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
    op: "move-widget",
    widgetId: "f1d1a000-0000-4000-8000-000000000401",
    at: "bottom",
  });

  const updated = Effect.runSync(applyDashboardEdit({ document, edit }));

  expect(updated).toEqual(document);
});

it("replaces the complete widget configuration while retaining its identity and region", () => {
  const widgetId = "f1d1a000-0000-4000-8000-000000000401";
  const edit = Schema.decodeUnknownSync(DashboardEdit)({
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
