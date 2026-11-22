import { BigDecimal, DateTime, Option, Schema } from "effect";
import {
  type Category,
  Category as CategorySchema,
  Currency,
  DashboardCatalogEntry,
  TransactionId,
} from "@/transport/client";
import type { DashboardLayout, DashboardView, DashboardWidgetView } from "./presentation";

export type PreviewDataset = "demo" | "worst" | "empty";

const uuidSuffixLength = 12;

const monthDayCount = 28;

const worstTransactionCount = 9;

const fallbackTransactionCount = 5;

const uid = (index: number): string =>
  `56000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixLength, "0")}`;

const categoryLabels = [
  "Mantenimiento y administración de propiedades familiares rurales e internacional",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Á",
  "家庭日用品・教育費・海外旅行の積立",
  "👨‍👩‍👧‍👦 Educación y cuidados familiares",
];

const fixtureCategory = (index: number): Category =>
  Schema.decodeSync(CategorySchema)({
    id: uid(index),
    label: categoryLabels[index % categoryLabels.length] ?? "Servicios",
  });

const counterparties = [
  "Administración y mantenimiento extraordinario del conjunto residencial familiar Los Arrayanes — torre norte",
  "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  "J",
  "家庭日用品・教育費・海外旅行の積立",
  "👩🏽‍💻 Asesoría de tecnología y diseño — Đặng Thị Ngọc Hân",
  "نور الهدى عبد الرحمن",
  "Créditos & seguros <anuales> **renovación**",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Ólafur Darri Ólafsson — honorarios internacionales",
];

const missingCounterpartyIndex = 8;

const amountCases: ReadonlyArray<Readonly<{ currency: Currency; amount: string }>> = [
  { currency: Currency.make("COP"), amount: "12345678901.99" },
  { currency: Currency.make("USD"), amount: "999999.99" },
  { currency: Currency.make("JPY"), amount: "1" },
  { currency: Currency.make("KWD"), amount: "0.001" },
  { currency: Currency.make("EUR"), amount: "0.01" },
  { currency: Currency.make("COP"), amount: "0.01" },
];

const defaultAmountCase = amountCases[0] ?? { currency: Currency.make("COP"), amount: "0" };

type FixtureMoney = Readonly<{ currency: Currency; amount: BigDecimal.BigDecimal }>;

const money = (index: number, amount?: string): FixtureMoney => {
  const entry = amountCases[index % amountCases.length] ?? defaultAmountCase;

  return {
    currency: entry.currency,
    amount: BigDecimal.fromStringUnsafe(amount ?? entry.amount),
  };
};

type WidgetViewFor<Type extends string> = Extract<DashboardWidgetView, { widget: { type: Type } }>;

type TransactionListView = WidgetViewFor<"transaction-list">;

type SpendingChartView = WidgetViewFor<"spending-chart">;

type BudgetBarView = WidgetViewFor<"budget-bar">;

type CustomMetricView = WidgetViewFor<"custom-metric">;

const isTransactionList = (view: DashboardWidgetView): view is TransactionListView =>
  view.widget.type === "transaction-list";

const isSpendingChart = (view: DashboardWidgetView): view is SpendingChartView =>
  view.widget.type === "spending-chart";

const isBudgetBar = (view: DashboardWidgetView): view is BudgetBarView =>
  view.widget.type === "budget-bar";

const fixtureTransactions = (
  count: number
): ReadonlyArray<TransactionListView["result"]["transactions"][number]> =>
  Array.from({ length: count }, (_, index) => ({
    id: TransactionId.make(uid(index)),
    money: money(index),
    counterparty:
      index === missingCounterpartyIndex
        ? Option.none()
        : Option.some(counterparties[index % counterparties.length] ?? "Servicio"),
    direction: index % 3 === 0 ? ("inflow" as const) : ("outflow" as const),
    category: fixtureCategory(index),
    occurredAt: DateTime.makeUnsafe(
      `2026-11-${String(1 + (index % monthDayCount)).padStart(2, "0")}T12:30:00Z`
    ),
  }));

const fixtureMoneyGroups = (
  index: number,
  empty: boolean
): CustomMetricView["result"]["moneyGroups"] =>
  empty
    ? []
    : [
        {
          currency: (amountCases[index % amountCases.length] ?? defaultAmountCase).currency,
          inflow: money(index),
          outflow: money(index + 2, index % 2 === 0 ? "9876543210.55" : undefined),
        },
      ];

const transactionCount = (index: number, empty: boolean): number => {
  if (empty) return 0;

  return index === 0 ? worstTransactionCount : fallbackTransactionCount;
};

const transactionListFixture = (
  view: TransactionListView,
  index: number,
  empty: boolean
): TransactionListView => {
  const widget =
    index === 0 && !empty
      ? { ...view.widget, title: "Movimientos recientes del período fiscal internacional" }
      : view.widget;

  return {
    ...view,
    widget,
    result: {
      ...view.result,
      transactions: fixtureTransactions(transactionCount(index, empty)),
    },
  };
};

const spendingChartFixture = (
  view: SpendingChartView,
  index: number,
  empty: boolean
): SpendingChartView => ({
  ...view,
  result: {
    ...view.result,
    buckets: view.result.buckets.map((bucket, bucketIndex) => ({
      ...bucket,
      moneyGroups: fixtureMoneyGroups(index + bucketIndex, empty),
    })),
  },
});

const budgetBarFixture = (view: BudgetBarView, index: number): BudgetBarView => {
  if (view.result.availability !== "available") {
    return { ...view, result: { ...view.result, category: fixtureCategory(index) } };
  }

  const over = index % 2 === 0;

  return {
    ...view,
    result: {
      ...view.result,
      category: fixtureCategory(index),
      cap: money(index, "9876543210.99"),
      spent: money(index, over ? "10000000000.01" : "0.01"),
      status: over
        ? { type: "over" as const, overBy: money(index, "123456789.02") }
        : { type: "under" as const, remaining: money(index, "9876543210.98") },
    },
  };
};

const customMetricFixture = (
  view: CustomMetricView,
  index: number,
  empty: boolean
): CustomMetricView => {
  const widget =
    index === 0 && !empty
      ? {
          ...view.widget,
          label: "Gasto mensual consolidado en monedas internacionales de reserva",
        }
      : view.widget;

  return {
    ...view,
    widget,
    result: { ...view.result, moneyGroups: fixtureMoneyGroups(index, empty) },
  };
};

const fixtureWidget = (
  widgetView: DashboardWidgetView,
  index: number,
  empty: boolean
): DashboardWidgetView => {
  if (isTransactionList(widgetView)) return transactionListFixture(widgetView, index, empty);

  if (isSpendingChart(widgetView)) return spendingChartFixture(widgetView, index, empty);

  if (isBudgetBar(widgetView)) return budgetBarFixture(widgetView, index);

  return customMetricFixture(widgetView, index, empty);
};

const mapLayout = (
  node: DashboardLayout,
  visit: (widget: DashboardWidgetView, index: number) => DashboardWidgetView,
  index: { value: number }
): DashboardLayout => {
  if (node.kind === "leaf") {
    const visited = visit(node.widget, index.value);
    index.value += 1;

    return { ...node, widget: visited };
  }

  const [first, second, ...rest] = node.children;

  return {
    ...node,
    children: [
      { ...first, node: mapLayout(first.node, visit, index) },
      { ...second, node: mapLayout(second.node, visit, index) },
      ...rest.map((child) => ({ ...child, node: mapLayout(child.node, visit, index) })),
    ],
  };
};

export const fixtureView = ({
  view,
  dataset,
}: Readonly<{ view: DashboardView; dataset: PreviewDataset }>): DashboardView => {
  if (dataset === "demo") return view;

  const index = { value: 0 };

  return {
    ...view,
    title:
      dataset === "worst"
        ? "Tablero consolidado de la familia internacional Wiśniewska-Kowalczyk"
        : view.title,
    layout: mapLayout(
      view.layout,
      (widget, widgetIndex) => fixtureWidget(widget, widgetIndex, dataset === "empty"),
      index
    ),
  };
};

const catalogNames = [
  "Panel de gastos extraordinarios internacionales por categoría consolidada",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Á",
  "家庭日用品・教育費・海外旅行の積立",
];

export const fixtureCatalog = ({
  catalog,
  dataset,
}: Readonly<{
  catalog: ReadonlyArray<DashboardCatalogEntry>;
  dataset: PreviewDataset;
}>): ReadonlyArray<DashboardCatalogEntry> =>
  dataset === "worst"
    ? catalog.map((entry, index) =>
        DashboardCatalogEntry.make({
          ...entry,
          name: DashboardCatalogEntry.fields.name.make(
            catalogNames[index % catalogNames.length] ?? entry.name
          ),
          description: DashboardCatalogEntry.fields.description.make(
            index === 0
              ? "Resumen mensual de los movimientos consolidados en monedas internacionales para todas las propiedades familiares"
              : entry.description
          ),
        })
      )
    : catalog;
