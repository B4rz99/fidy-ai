import { type CategoryId } from "~/core/_shared/category";
import {
  DashboardCatalogEntry,
  DashboardPeriod,
  DashboardTitle,
  SpendingGroupBy,
  TransactionListLimit,
  type DashboardCatalog,
  type DashboardDocument,
  type Widget,
  type WidgetId,
} from "./model";

const monthlySpending = DashboardCatalogEntry.make({
  id: "monthly-spending",
  name: "Gastos del mes",
  description: "Compara entradas y salidas del mes por categoría y moneda.",
  widget: {
    type: "spending-chart",
    title: "Gastos por categoría",
    groupBy: SpendingGroupBy.make("category"),
    period: DashboardPeriod.make("this-month"),
  },
});

const restaurantBudgetCop = (categoryId: CategoryId): DashboardCatalogEntry =>
  DashboardCatalogEntry.make({
    id: "restaurant-budget-cop",
    name: "Presupuesto de restaurantes",
    description: "Sigue el presupuesto mensual de restaurantes expresado en COP.",
    widget: {
      type: "budget-bar",
      title: "Presupuesto de restaurantes",
      categoryId,
      currency: "COP",
    },
  });

const recentTransactions = DashboardCatalogEntry.make({
  id: "recent-transactions",
  name: "Transacciones recientes",
  description: "Muestra las diez transacciones más recientes con su moneda original.",
  widget: {
    type: "transaction-list",
    title: "Transacciones recientes",
    limit: TransactionListLimit.make(10),
  },
});

const monthlyOutflows = DashboardCatalogEntry.make({
  id: "monthly-outflows",
  name: "Salidas del mes",
  description: "Resume las salidas del mes sin mezclar monedas ni calcular un neto.",
  widget: {
    type: "custom-metric",
    label: "Salidas del mes",
    aggregation: "sum",
    period: DashboardPeriod.make("this-month"),
  },
});

/** Builds the four direct-launch presets from the shell-supplied restaurant CategoryId. */
export const makeDashboardCatalog = (
  input: Readonly<{ readonly restaurantCategoryId: CategoryId }>
): DashboardCatalog => [
  monthlySpending,
  restaurantBudgetCop(input.restaurantCategoryId),
  recentTransactions,
  monthlyOutflows,
];

/** Assigns caller-generated identity to one already-valid catalog template. */
export const makeCatalogWidget = (
  input: Readonly<{
    readonly entry: DashboardCatalogEntry;
    readonly id: WidgetId;
  }>
): Widget => ({ ...input.entry.widget, id: input.id });

/** Creates the non-empty first-use document retained for one User. */
export const makeDefaultDashboard = (
  input: Readonly<{ readonly widgetId: WidgetId }>
): DashboardDocument => ({
  title: DashboardTitle.make("Mi tablero"),
  layout: {
    kind: "leaf",
    widget: makeCatalogWidget({ entry: monthlySpending, id: input.widgetId }),
  },
});
