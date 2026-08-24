import { DateTime, Option, Schema, Struct } from "effect";
import { CategoryId } from "~/core/categories/reference";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { Currency } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumDashboardLabelLength = 80;
const maximumCatalogTextLength = 160;
const maximumFilteredCategories = 16;
const maximumWidgetsPerDashboard = 24;
const maximumLayoutDepth = 8;

/** Stable identity of one widget inside the User's DashboardDocument. */
export const WidgetId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("WidgetId"))
  .annotate({ identifier: "WidgetId" });
export type WidgetId = typeof WidgetId.Type;

/** User-visible heading for their one dashboard. */
export const DashboardTitle = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumDashboardLabelLength)
);
export type DashboardTitle = typeof DashboardTitle.Type;

/** Optional user-visible heading for one widget. */
export const WidgetTitle = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumDashboardLabelLength)
);
export type WidgetTitle = typeof WidgetTitle.Type;

/** Closed relative periods accepted by dashboard widgets. */
export const DashboardPeriod = Schema.Literals([
  "this-week",
  "this-month",
  "last-week",
  "last-month",
  "last-7-days",
  "last-30-days",
]);
export type DashboardPeriod = typeof DashboardPeriod.Type;

/** Dimension used to bucket one spending chart without changing monetary grouping. */
export const SpendingGroupBy = Schema.Literals(["category", "day", "month"]);
export type SpendingGroupBy = typeof SpendingGroupBy.Type;

const CategoryFilter = Schema.TupleWithRest(Schema.Tuple([CategoryId]), [CategoryId]).check(
  Schema.isMaxLength(maximumFilteredCategories),
  Schema.isUnique()
);

const MetricLabel = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumDashboardLabelLength)
);

/** Currency-preserving monetary calculation supported by a custom metric. */
export const MoneyAggregation = Schema.Literals(["sum", "average", "maximum"]);
export type MoneyAggregation = typeof MoneyAggregation.Type;

/** Presentation and jurisdiction applied when ephemeral widget data was calculated. */
export const DashboardQueryContext = Schema.Struct({
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
}).annotate({ identifier: "DashboardQueryContext" });
export type DashboardQueryContext = typeof DashboardQueryContext.Type;

const validAppliedPeriod = Schema.makeFilter<
  Readonly<{ readonly from: DateTime.Utc; readonly toExclusive: DateTime.Utc }>
>((period) =>
  DateTime.Order(period.from, period.toExclusive) < 0
    ? undefined
    : { path: ["toExclusive"], issue: "Expected an instant after from" }
);

/** Half-open UTC interval resolved from a relative period in the applied time zone. */
export const AppliedDashboardPeriod = Schema.Struct({
  requested: DashboardPeriod,
  from: UtcTimestamp,
  toExclusive: UtcTimestamp,
  timeZone: IanaTimeZone,
})
  .check(validAppliedPeriod)
  .annotate({ identifier: "AppliedDashboardPeriod" });
export type AppliedDashboardPeriod = typeof AppliedDashboardPeriod.Type;

const TransactionSearch = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(100)
);

/** Maximum number of recent Transactions requested by one list widget. */
export const TransactionListLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
  .pipe(Schema.brand("TransactionListLimit"))
  .annotate({ identifier: "TransactionListLimit" });
export type TransactionListLimit = typeof TransactionListLimit.Type;

const WidgetBase = {
  id: WidgetId,
  title: Schema.optionalKey(WidgetTitle),
} as const;

/** A time-bounded chart whose eventual Money output remains grouped by Currency. */
export const SpendingChartWidget = Schema.Struct({
  ...WidgetBase,
  type: Schema.tag("spending-chart"),
  groupBy: SpendingGroupBy,
  period: DashboardPeriod,
  categories: Schema.optionalKey(CategoryFilter),
}).annotate({ identifier: "SpendingChartWidget" });
export type SpendingChartWidget = typeof SpendingChartWidget.Type;

/** A current monthly Budget selected by its Category and explicit Currency. */
export const BudgetBarWidget = Schema.Struct({
  ...WidgetBase,
  type: Schema.tag("budget-bar"),
  categoryId: CategoryId,
  currency: Currency,
}).annotate({ identifier: "BudgetBarWidget" });
export type BudgetBarWidget = typeof BudgetBarWidget.Type;

/** Raw recent Transactions; nested Money preserves each Transaction's Currency. */
export const TransactionListWidget = Schema.Struct({
  ...WidgetBase,
  type: Schema.tag("transaction-list"),
  limit: TransactionListLimit,
  categories: Schema.optionalKey(CategoryFilter),
  search: Schema.optionalKey(TransactionSearch),
}).annotate({ identifier: "TransactionListWidget" });
export type TransactionListWidget = typeof TransactionListWidget.Type;

/** A monetary aggregation whose eventual result is grouped by Currency. */
export const CustomMetricWidget = Schema.Struct({
  ...WidgetBase,
  type: Schema.tag("custom-metric"),
  label: MetricLabel,
  aggregation: MoneyAggregation,
  period: DashboardPeriod,
  categories: Schema.optionalKey(CategoryFilter),
}).annotate({ identifier: "CustomMetricWidget" });
export type CustomMetricWidget = typeof CustomMetricWidget.Type;

/** Closed set of dashboard widgets. Additional variants are added at this one seam. */
export const Widget = Schema.Union([
  SpendingChartWidget,
  BudgetBarWidget,
  TransactionListWidget,
  CustomMetricWidget,
])
  .annotate({ identifier: "Widget" })
  .pipe(Schema.toTaggedUnion("type"));
export type Widget = typeof Widget.Type;

// `mapFields` keeps no struct-level annotation, so each template renames itself.
const SpendingChartTemplate = SpendingChartWidget.mapFields(Struct.omit(["id"])).annotate({
  identifier: "SpendingChartTemplate",
});
const BudgetBarTemplate = BudgetBarWidget.mapFields(Struct.omit(["id"])).annotate({
  identifier: "BudgetBarTemplate",
});
const TransactionListTemplate = TransactionListWidget.mapFields(Struct.omit(["id"])).annotate({
  identifier: "TransactionListTemplate",
});
const CustomMetricTemplate = CustomMetricWidget.mapFields(Struct.omit(["id"])).annotate({
  identifier: "CustomMetricTemplate",
});

/** Catalog-ready Widget config that receives identity only when it is added. */
export const WidgetTemplate = Schema.Union([
  SpendingChartTemplate,
  BudgetBarTemplate,
  TransactionListTemplate,
  CustomMetricTemplate,
])
  .annotate({ identifier: "WidgetTemplate" })
  .pipe(Schema.toTaggedUnion("type"));
export type WidgetTemplate = typeof WidgetTemplate.Type;

/** Orientation of a split: row is side-by-side and column is stacked. */
export const Axis = Schema.Literals(["row", "column"]);
export type Axis = typeof Axis.Type;

/** Positive bounded integer interpreted only relative to sibling weights. */
export const SplitWeight = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
  .pipe(Schema.brand("SplitWeight"))
  .annotate({ identifier: "SplitWeight" });
export type SplitWeight = typeof SplitWeight.Type;

/** Terminal region of the one recursive Dashboard layout grammar. */
export type LayoutLeaf<Leaf> = Readonly<{
  readonly kind: "leaf";
  readonly widget: Leaf;
}>;

/** One weighted child region whose share is relative only to its siblings. */
export type WeightedLayoutChild<Leaf, Weight = SplitWeight> = Readonly<{
  readonly weight: Weight;
  readonly node: LayoutNodeFor<Leaf, Weight>;
}>;

/** Canonical row or column of at least two weighted child regions. */
export type LayoutSplit<Leaf, Weight = SplitWeight> = Readonly<{
  readonly kind: "split";
  readonly axis: Axis;
  readonly children: readonly [
    WeightedLayoutChild<Leaf, Weight>,
    WeightedLayoutChild<Leaf, Weight>,
    ...Array<WeightedLayoutChild<Leaf, Weight>>,
  ];
}>;

/** One recursive grammar parameterized by its leaf value and decoded/encoded weight. */
export type LayoutNodeFor<Leaf, Weight = SplitWeight> =
  | LayoutLeaf<Leaf>
  | LayoutSplit<Leaf, Weight>;

type LayoutSchemaInput<Leaf extends Schema.Top> = Readonly<{
  leaf: () => Leaf;
  identifier: string;
}>;

type LayoutNodeSchema<Leaf extends Schema.Top> = Schema.Codec<
  LayoutNodeFor<Leaf["Type"]>,
  LayoutNodeFor<Leaf["Encoded"], number>,
  Leaf["DecodingServices"],
  Leaf["EncodingServices"]
>;

/**
 * Builds the shared recursive layout codec. DashboardDocument and DashboardView instantiate this
 * grammar with different closed leaf schemas; neither owns a parallel layout implementation.
 */
export const makeLayoutNodeSchema = <Leaf extends Schema.Top>(
  input: LayoutSchemaInput<Leaf>
): LayoutNodeSchema<Leaf> => {
  const { identifier } = input;
  const leaf = input.leaf();
  const node: Schema.Codec<unknown, unknown, unknown, unknown> = Schema.suspend(() => {
    const child = Schema.Struct({
      weight: SplitWeight,
      node: Schema.suspend((): Schema.Codec<unknown, unknown, unknown, unknown> => node),
    });
    return Schema.Union([
      Schema.Struct({ kind: Schema.Literal("leaf"), widget: leaf }),
      Schema.Struct({
        kind: Schema.Literal("split"),
        axis: Axis,
        children: Schema.TupleWithRest(Schema.Tuple([child, child]), [child]).check(
          Schema.isMaxLength(maximumWidgetsPerDashboard)
        ),
      }),
    ]);
  }).annotate({ identifier });
  return Schema.make(node.ast);
};

/** Recursive persisted layout instantiated from the shared grammar. */
export const LayoutNode = makeLayoutNodeSchema({ leaf: () => Widget, identifier: "LayoutNode" });
/** Recursive Dashboard layout whose in-order leaves define mobile order. */
export type LayoutNode = typeof LayoutNode.Type;
/** Terminal persisted layout region containing exactly one Widget. */
export type LeafNode = Extract<LayoutNode, { readonly kind: "leaf" }>;
/** Canonical persisted split region. */
export type SplitNode = Extract<LayoutNode, { readonly kind: "split" }>;

const DashboardDocumentShape = Schema.Struct({
  title: DashboardTitle,
  layout: LayoutNode,
});
type DashboardDocumentShape = typeof DashboardDocumentShape.Type;

/** One structural DashboardDocument violation at an exact nested path. */
export type DashboardStructureIssue = Readonly<{
  readonly path: ReadonlyArray<string | number>;
  readonly issue: string;
}>;

type VisitContext = Readonly<{
  readonly depth: number;
  readonly parentAxis: Option.Option<Axis>;
  readonly path: ReadonlyArray<string | number>;
}>;

/** Finds the first structural invariant violation with its document-relative path. */
export const findDashboardStructureIssue = (
  document: Readonly<DashboardDocumentShape>
): Option.Option<DashboardStructureIssue> => {
  const widgetIds = new Set<WidgetId>();
  let widgetCount = 0;
  let issue: Option.Option<DashboardStructureIssue> = Option.none();

  const visit = (node: Readonly<LayoutNode>, context: Readonly<VisitContext>): void => {
    if (Option.isSome(issue)) {
      return;
    }
    if (node.kind === "leaf") {
      widgetCount += 1;
      if (widgetCount > maximumWidgetsPerDashboard) {
        issue = Option.some({
          path: context.path,
          issue: "DashboardDocument permits at most 24 widgets",
        });
        return;
      }
      if (widgetIds.has(node.widget.id)) {
        issue = Option.some({
          path: [...context.path, "widget", "id"],
          issue: "Expected a unique WidgetId in DashboardDocument",
        });
        return;
      }
      widgetIds.add(node.widget.id);
      return;
    }
    if (context.depth >= maximumLayoutDepth) {
      issue = Option.some({
        path: context.path,
        issue: "DashboardDocument layout depth must not exceed 8",
      });
      return;
    }
    if (Option.contains(context.parentAxis, node.axis)) {
      issue = Option.some({
        path: [...context.path, "axis"],
        issue: "Expected canonical layout without nested splits on the same axis",
      });
      return;
    }
    for (const [index, child] of node.children.entries()) {
      visit(child.node, {
        depth: context.depth + 1,
        parentAxis: Option.some(node.axis),
        path: [...context.path, "children", index, "node"],
      });
    }
  };

  visit(document.layout, { depth: 0, parentAxis: Option.none(), path: ["layout"] });
  return issue;
};

const validDocumentStructure = Schema.makeFilter<DashboardDocumentShape>((document) =>
  Option.toArray(findDashboardStructureIssue(document))
);

/**
 * The one persistent dashboard configuration for a User. Identity and ownership
 * come from authenticated operation context, not fields in this document.
 */
export const DashboardDocument = DashboardDocumentShape.check(validDocumentStructure).annotate({
  identifier: "DashboardDocument",
});
export type DashboardDocument = typeof DashboardDocument.Type;

/** Stable identity of one built-in direct-launch catalog preset. */
export const CatalogPresetId = Schema.Literals([
  "monthly-spending",
  "restaurant-budget-cop",
  "recent-transactions",
  "monthly-outflows",
]);
export type CatalogPresetId = typeof CatalogPresetId.Type;

const CatalogText = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumCatalogTextLength)
);

/** One named direct-launch preset carrying a complete Widget template. */
export const DashboardCatalogEntry = Schema.Struct({
  id: CatalogPresetId,
  name: CatalogText,
  description: CatalogText,
  widget: WidgetTemplate,
}).annotate({ identifier: "DashboardCatalogEntry" });
export type DashboardCatalogEntry = typeof DashboardCatalogEntry.Type;

/** Exact ordered collection of the four built-in direct-launch Widget presets. */
export const DashboardCatalog = Schema.Tuple([
  DashboardCatalogEntry,
  DashboardCatalogEntry,
  DashboardCatalogEntry,
  DashboardCatalogEntry,
]);
export type DashboardCatalog = typeof DashboardCatalog.Type;

/** Edit replacing only the User-visible dashboard heading. */
export const SetTitle = Schema.Struct({
  op: Schema.tag("set-title"),
  title: DashboardTitle,
}).annotate({ identifier: "SetTitle" });
export type SetTitle = typeof SetTitle.Type;

const BesidePlacement = Schema.Struct({
  besideWidget: WidgetId,
  axis: Axis,
  side: Schema.Literals(["before", "after"]),
}).annotate({ identifier: "BesidePlacement" });
export type BesidePlacement = typeof BesidePlacement.Type;

/** Whether a Placement names a sibling Widget rather than a document edge. */
export const isBesidePlacement = Schema.is(BesidePlacement);

/** Root or sibling-relative destination accepted by add and move edits. */
export const Placement = Schema.Union([Schema.Literals(["top", "bottom"]), BesidePlacement]);
export type Placement = typeof Placement.Type;

/** Edit adding a fresh complete Widget at a structural destination. */
export const AddWidget = Schema.Struct({
  op: Schema.tag("add-widget"),
  widget: Widget,
  at: Placement,
}).annotate({ identifier: "AddWidget" });
export type AddWidget = typeof AddWidget.Type;

/** Edit removing one Widget while retaining a non-empty canonical layout. */
export const RemoveWidget = Schema.Struct({
  op: Schema.tag("remove-widget"),
  widgetId: WidgetId,
}).annotate({ identifier: "RemoveWidget" });
export type RemoveWidget = typeof RemoveWidget.Type;

/** Edit moving an existing Widget without changing its identity or configuration. */
export const MoveWidget = Schema.Struct({
  op: Schema.tag("move-widget"),
  widgetId: WidgetId,
  at: Placement,
}).annotate({ identifier: "MoveWidget" });
export type MoveWidget = typeof MoveWidget.Type;

/** Edit changing the sibling-relative weight of a non-root Widget region. */
export const ResizeWidget = Schema.Struct({
  op: Schema.tag("resize-widget"),
  widgetId: WidgetId,
  weight: SplitWeight,
}).annotate({ identifier: "ResizeWidget" });
export type ResizeWidget = typeof ResizeWidget.Type;

/** Edit replacing a Widget's complete configuration at its existing region. */
export const UpdateWidget = Schema.Struct({
  op: Schema.tag("update-widget"),
  widget: Widget,
}).annotate({ identifier: "UpdateWidget" });
export type UpdateWidget = typeof UpdateWidget.Type;

/** Shared edit vocabulary decoded identically for every dashboard client. */
export const DashboardEdit = Schema.Union([
  SetTitle,
  AddWidget,
  RemoveWidget,
  MoveWidget,
  ResizeWidget,
  UpdateWidget,
])
  .annotate({ identifier: "DashboardEdit" })
  .pipe(Schema.toTaggedUnion("op"));
export type DashboardEdit = typeof DashboardEdit.Type;

/** Collects Widgets once in the in-order traversal that also defines mobile order. */
export const collectLayoutWidgets = (node: Readonly<LayoutNode>): ReadonlyArray<Widget> =>
  node.kind === "leaf"
    ? [node.widget]
    : node.children.flatMap((child) => collectLayoutWidgets(child.node));

/** One Category reference and its field relative to the Widget that carries it. */
export type DashboardCategoryReference = Readonly<{
  readonly categoryId: CategoryId;
  readonly widgetId: WidgetId;
  readonly field: "categoryId" | `categories.${number}`;
}>;

/** The Widgets whose Category filter is optional; absence is not an empty filter. */
type FilteredWidget = SpendingChartWidget | TransactionListWidget | CustomMetricWidget;

const collectFilteredWidgetReferences = (
  widget: Readonly<FilteredWidget>
): ReadonlyArray<DashboardCategoryReference> =>
  widget.categories === undefined
    ? []
    : widget.categories.map((categoryId, index) => ({
        categoryId,
        widgetId: widget.id,
        field: `categories.${index}` satisfies `categories.${number}`,
      }));

/** Collects Category references without exposing recursive traversal to the shell. */
export const collectDashboardCategoryReferences = (
  document: Readonly<DashboardDocument>
): ReadonlyArray<DashboardCategoryReference> =>
  collectLayoutWidgets(document.layout).flatMap(
    Widget.match({
      "budget-bar": (widget) => [
        { categoryId: widget.categoryId, widgetId: widget.id, field: "categoryId" as const },
      ],
      "spending-chart": collectFilteredWidgetReferences,
      "transaction-list": collectFilteredWidgetReferences,
      "custom-metric": collectFilteredWidgetReferences,
    })
  );
