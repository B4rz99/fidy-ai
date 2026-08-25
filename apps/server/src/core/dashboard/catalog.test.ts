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

it("creates a valid non-empty first-use DashboardDocument", () => {
  const document = makeDefaultDashboard({
    widgetId: WidgetId.make("f1d1a000-0000-4000-8000-000000000511"),
  });

  expect(document.title).toBe("Tablero");
  expect(() => Schema.encodeSync(DashboardDocument)(document)).not.toThrow();
});
