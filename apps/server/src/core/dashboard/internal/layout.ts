import {
  type CustomMetricWidget,
  type DashboardCategoryReference,
  type DashboardDocument,
  type LayoutNode,
  type SpendingChartWidget,
  type TransactionListWidget,
  Widget,
} from "~/core/dashboard/contract";
/** Collects Widgets once in the in-order traversal that also defines mobile order. */
export const collectLayoutWidgets = (node: Readonly<LayoutNode>): ReadonlyArray<Widget> =>
  node.kind === "leaf"
    ? [node.widget]
    : node.children.flatMap((child) => collectLayoutWidgets(child.node));

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
