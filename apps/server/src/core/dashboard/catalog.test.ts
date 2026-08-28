import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { CategoryId } from "~/core/categories/reference";
import { makeCatalogWidget, makeDashboardCatalog, makeDefaultDashboard } from "./catalog";
import { DashboardDocument, Widget, WidgetId } from "./model";

it("provides one valid direct-launch preset for every closed widget type", () => {
  const ids = [
    "f1d1a000-0000-4000-8000-000000000501",
    "f1d1a000-0000-4000-8000-000000000502",
    "f1d1a000-0000-4000-8000-000000000503",
    "f1d1a000-0000-4000-8000-000000000504",
  ].map((id) => WidgetId.make(id));
  const fallbackId = WidgetId.make("f1d1a000-0000-4000-8000-000000000500");
  const dashboardCatalog = makeDashboardCatalog({
    restaurantCategoryId: CategoryId.make("10000000-0000-4000-8000-000000000001"),
  });

  const widgets = dashboardCatalog.map((entry, index) =>
    makeCatalogWidget({ entry, id: ids[index] ?? fallbackId })
  );

  expect(widgets.map(({ type }) => type)).toEqual([
    "spending-chart",
    "budget-bar",
    "transaction-list",
    "custom-metric",
  ]);
  for (const widget of widgets) {
    expect(() => Schema.encodeSync(Widget)(widget)).not.toThrow();
  }
});

it("creates a valid four-Widget first-use DashboardDocument in a two-by-two layout", () => {
  const document = makeDefaultDashboard({
    restaurantCategoryId: CategoryId.make("10000000-0000-4000-8000-000000000001"),
    widgetIds: [
      WidgetId.make("f1d1a000-0000-4000-8000-000000000511"),
      WidgetId.make("f1d1a000-0000-4000-8000-000000000512"),
      WidgetId.make("f1d1a000-0000-4000-8000-000000000513"),
      WidgetId.make("f1d1a000-0000-4000-8000-000000000514"),
    ],
  });

  expect(document.title).toBe("Tablero");
  expect(document.layout.kind).toBe("split");
  if (document.layout.kind !== "split") throw new Error("Expected the default row stack");
  expect(document.layout.axis).toBe("column");
  expect(document.layout.children).toHaveLength(2);
  for (const row of document.layout.children) {
    expect(row.node.kind).toBe("split");
    if (row.node.kind !== "split") throw new Error("Expected a default Widget row");
    expect(row.node.axis).toBe("row");
    expect(row.node.children).toHaveLength(2);
  }
  expect(() => Schema.encodeSync(DashboardDocument)(document)).not.toThrow();
});
