import { type CategoryId } from "~/core/categories/reference";
import {
  type DashboardCatalog,
  DashboardCatalogEntry,
  type DashboardDocument,
  DashboardPeriod,
  DashboardTitle,
  SpendingGroupBy,
  SplitWeight,
  TransactionListLimit,
  type Widget,
  type WidgetId,
} from "./model";

const recentTransactionsPresetLimit = 10;

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
    limit: TransactionListLimit.make(recentTransactionsPresetLimit),
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

type DefaultWidgetIds = readonly [WidgetId, WidgetId, WidgetId, WidgetId];

const defaultWeight = SplitWeight.make(1);

/** Creates the four-Widget, two-by-two first-use document retained for one User. */
export const makeDefaultDashboard = (
  input: Readonly<{
    readonly restaurantCategoryId: CategoryId;
    readonly widgetIds: DefaultWidgetIds;
  }>
): DashboardDocument => {
  const catalog = makeDashboardCatalog({ restaurantCategoryId: input.restaurantCategoryId });
  const [firstId, secondId, thirdId, fourthId] = input.widgetIds;
  const first = {
    kind: "leaf" as const,
    widget: makeCatalogWidget({ entry: catalog[0], id: firstId }),
  };
  const second = {
    kind: "leaf" as const,
    widget: makeCatalogWidget({ entry: catalog[1], id: secondId }),
  };
  const third = {
    kind: "leaf" as const,
    widget: makeCatalogWidget({ entry: catalog[2], id: thirdId }),
  };
  const fourth = {
    kind: "leaf" as const,
    widget: makeCatalogWidget({ entry: catalog[3], id: fourthId }),
  };
  return {
    title: DashboardTitle.make("Tablero"),
    layout: {
      kind: "split",
      axis: "column",
      children: [
        {
          weight: defaultWeight,
          node: {
            kind: "split",
            axis: "row",
            children: [
              { weight: defaultWeight, node: first },
              { weight: defaultWeight, node: second },
            ],
          },
        },
        {
          weight: defaultWeight,
          node: {
            kind: "split",
            axis: "row",
            children: [
              { weight: defaultWeight, node: third },
              { weight: defaultWeight, node: fourth },
            ],
          },
        },
      ],
    },
  };
};
