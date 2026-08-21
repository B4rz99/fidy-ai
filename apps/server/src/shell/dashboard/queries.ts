import { Effect } from "effect";
import { categoryIds } from "~/core/categories/taxonomy";
import { makeDashboardCatalog } from "~/core/dashboard/catalog";

const dashboardCatalog = makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes });

/** Reads the widget catalog every caller shares; it is derived from the taxonomy, not persisted. */
export const listDashboardCatalog = Effect.succeed({ data: dashboardCatalog, next: [] });
