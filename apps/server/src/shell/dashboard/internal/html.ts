import { BigDecimal, DateTime, Option } from "effect";
import { type MoneyGroups, type ReadonlyMoney, encodeMoneyAmount } from "~/core/_shared/money";
import type { DashboardBucket } from "~/core/dashboard/contract";
import type { DashboardView, DashboardWidgetView } from "../contract";

const escape = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
const money = (value: ReadonlyMoney): string =>
  `${value.amount.pipe(encodeMoneyAmount, escape)} ${escape(value.currency)}`;
const groups = (values: MoneyGroups): string =>
  values.length === 0
    ? "<p>No hay transacciones en este periodo</p>"
    : values
        .map(
          (group) =>
            `<dl class="dashboard-html-figures"><dt>Entradas</dt><dd>${money(group.inflow)}</dd><dt>Salidas</dt><dd>${money(group.outflow)}</dd></dl>`
        )
        .join("");
const bucketLabel = (key: DashboardBucket): string => {
  switch (key.kind) {
    case "category":
      return key.category.label;
    case "day":
      return key.date;
    case "month":
      return key.month;
  }
};
const title = (entry: DashboardWidgetView): string => {
  if (entry.widget.title !== undefined) return entry.widget.title;
  switch (entry.widget.type) {
    case "spending-chart":
      return "Gastos";
    case "budget-bar":
      return "Presupuesto";
    case "transaction-list":
      return "Transacciones recientes";
    case "custom-metric":
      return entry.widget.label;
  }
};
type RenderContext = DashboardView & Readonly<{ dateFormatter: Intl.DateTimeFormat }>;
const calendarMonthWidth = 7;
const transactionDate = (date: DateTime.Utc, view: RenderContext): string =>
  view.dateFormatter.format(date.epochMilliseconds);
const localDate = (date: DateTime.Utc, zone: string): string =>
  DateTime.formatIsoDate(DateTime.setZone(date, DateTime.zoneMakeNamedUnsafe(zone)));
const transactions = (
  entry: Extract<DashboardWidgetView["result"], { transactions: unknown }>,
  view: RenderContext
): string => {
  if (entry.transactions.length === 0) return "<p>No hay transacciones en esta lista</p>";
  return `<ul class="dashboard-html-transactions">${entry.transactions
    .map((transaction) => {
      const search = new URLSearchParams({
        month: localDate(transaction.occurredAt, view.context.timeZone).slice(
          0,
          calendarMonthWidth
        ),
        day: localDate(transaction.occurredAt, view.context.timeZone),
      });
      return `<li><a href="/app/transactions?${escape(search.toString())}"><span>${escape(Option.getOrElse(transaction.counterparty, () => transaction.category.label))}</span><span>${escape(transaction.category.label)}</span><time>${escape(transactionDate(transaction.occurredAt, view))}</time><strong>${transaction.direction === "outflow" ? "−" : "+"}${money(transaction.money)}</strong></a></li>`;
    })
    .join("")}</ul>`;
};
const budget = (
  result: Extract<DashboardWidgetView["result"], { availability: unknown }>
): string => {
  if (result.availability === "missing-budget") {
    return `<p>No hay presupuesto para este mes</p><p>${escape(result.category.label)} · ${escape(result.currency)}</p><a href="/app/budgets">Ir a Presupuestos</a>`;
  }
  let status = "Presupuesto alcanzado";
  if (result.status.type === "under") status = `Disponible ${money(result.status.remaining)}`;
  if (result.status.type === "over") status = `Excedido por ${money(result.status.overBy)}`;
  const bounded = BigDecimal.min(result.spent.amount, result.cap.amount);
  const ratio = Number(BigDecimal.format(BigDecimal.divideUnsafe(bounded, result.cap.amount)));
  return `<p>${escape(result.category.label)}</p><dl class="dashboard-html-figures"><dt>Gastado</dt><dd>${money(result.spent)}</dd><dt>Presupuesto</dt><dd>${money(result.cap)}</dd></dl><progress aria-label="Presupuesto utilizado" max="1" value="${ratio}"></progress><p>${status}</p>`;
};
type ChartResult = Extract<DashboardWidgetView["result"], { buckets: unknown }>;
const chartSeries = (result: ChartResult, currency: MoneyGroups[number]["currency"]): string => {
  const zero = BigDecimal.make(0n, 0);
  const values = result.buckets.map((bucket) => ({
    label: bucketLabel(bucket.key),
    amount: bucket.moneyGroups.find((group) => group.currency === currency)?.outflow.amount ?? zero,
  }));
  const maximum = values.reduce((largest, value) => BigDecimal.max(largest, value.amount), zero);
  if (BigDecimal.isZero(maximum)) return "";
  const percentage = 100;
  return `<section class="dashboard-html-series" aria-label="Serie ${escape(currency)}"><h3>${escape(currency)}</h3>${values
    .map((value) => {
      const amount = money({ amount: value.amount, currency });
      const width =
        Number(BigDecimal.format(BigDecimal.divideUnsafe(value.amount, maximum))) * percentage;
      return `<div class="dashboard-html-chart-row"><span>${escape(value.label)}</span><svg role="img" aria-label="${escape(value.label)}: ${amount}" viewBox="0 0 100 18" preserveAspectRatio="none"><rect width="${width}" height="18" fill="currentColor"></rect></svg><strong>${amount}</strong></div>`;
    })
    .join("")}</section>`;
};
const chart = (result: ChartResult): string => {
  const currencies = Array.from(
    new Set(result.buckets.flatMap((bucket) => bucket.moneyGroups.map((group) => group.currency)))
  );
  const series = currencies.map((currency) => chartSeries(result, currency)).join("");
  return series === ""
    ? "<p>No hay transacciones en este periodo</p>"
    : `<div class="dashboard-html-chart">${series}</div>`;
};
const widget = (entry: DashboardWidgetView, view: RenderContext): string => {
  const result = entry.result;
  let body: string;
  if ("transactions" in result) body = transactions(result, view);
  else if ("availability" in result) body = budget(result);
  else if ("buckets" in result) body = chart(result);
  else body = groups(result.moneyGroups);
  if ("appliedPeriod" in result) {
    body += `<p class="dashboard-html-period">${escape(transactionDate(result.appliedPeriod.from, view))} – ${escape(transactionDate(DateTime.subtract(result.appliedPeriod.toExclusive, { milliseconds: 1 }), view))}</p>`;
  }
  return `<section class="dashboard-html-card" data-widget-id="${escape(entry.widget.id)}"><h2>${escape(title(entry))}</h2>${body}</section>`;
};
const layout = (node: DashboardView["layout"], view: RenderContext): string => {
  if (node.kind === "leaf") return widget(node.widget, view);
  return `<div class="dashboard-html-layout dashboard-html-${node.axis}">${node.children.map((child) => `<div data-weight="${child.weight}">${layout(child.node, view)}</div>`).join("")}</div>`;
};

export const renderHtml = (view: DashboardView): string => {
  const context: RenderContext = {
    ...view,
    dateFormatter: new Intl.DateTimeFormat(view.context.locale, {
      timeZone: view.context.timeZone,
      dateStyle: "medium",
    }),
  };
  return `<main class="dashboard-surface dashboard-html" data-dashboard-read-state="ready"><header class="dashboard-header"><h1>${escape(view.title)}</h1><form method="get" action="/app/dashboard"><button type="submit" name="customize" value="1" data-dashboard-customize>Personalizar</button></form></header><div aria-label="Diseño responsivo del tablero">${layout(view.layout, context)}</div></main>`;
};
