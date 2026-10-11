import { BigDecimal, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { DashboardView, DashboardWidget, DashboardWidgetView } from "./presentation";
import { formatMoney, moneyProgressGeometry, moneySeriesGeometry } from "./money-presentation";

type Spending = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type Budget = Extract<DashboardWidgetView["result"], { readonly availability: unknown }>;
type Transactions = Extract<DashboardWidgetView["result"], { readonly transactions: unknown }>;
type Metric = Extract<DashboardWidgetView["result"], { readonly moneyGroups: unknown }>;
type Context = DashboardView["context"];
const chartWidth = 600;
const chartHeight = 180;
const plotHeight = 140;
const labelY = 165;
const barGap = 8;
const halfBar = 0.5;
/** Resolves the canonical optional title without changing a Widget's identity. */
export const widgetTitle = (widget: DashboardWidget): string => {
  if (widget.title !== undefined) return widget.title;
  switch (widget.type) {
    case "spending-chart":
      return "Transacciones";
    case "budget-bar":
      return "Presupuesto";
    case "transaction-list":
      return "Transacciones recientes";
    case "custom-metric":
      return widget.label;
  }
};
const bucketLabel = (key: Spending["buckets"][number]["key"]): string => {
  switch (key.kind) {
    case "category":
      return key.category.label;
    case "day":
      return key.date;
    case "month":
      return key.month;
  }
};
const empty = <Message>(label: string, html: HtmlBuilder<Message>): Html =>
  html.p([html.Class("rounded-lg border p-6 text-muted-foreground")], [label]);
const chartBar = <Message>({
  html,
  value,
  height,
  step,
  index,
  context,
}: Readonly<{
  html: HtmlBuilder<Message>;
  value: Readonly<{
    label: string;
    money: Spending["buckets"][number]["moneyGroups"][number]["outflow"];
  }>;
  height: number;
  step: number;
  index: number;
  context: Context;
}>): Html => {
  const exact = formatMoney({ money: value.money, locale: context.locale });
  return html.g(
    [html.Key(value.label)],
    [
      html.rect(
        [
          html.X(String(index * step + barGap / 2)),
          html.Y(String(plotHeight - height)),
          html.Width(String(Math.max(1, step - barGap))),
          html.Height(String(height)),
          html.Rx("4"),
          html.Fill("var(--chart-4)"),
          html.Tabindex(0),
          html.AriaLabel(`${value.label}: ${exact}`),
        ],
        [html.title([], [`${value.label}: ${exact}`])]
      ),
      html.text(
        [
          html.X(String((index + halfBar) * step)),
          html.Y(String(labelY)),
          html.TextAnchor("middle"),
          html.Fill("currentColor"),
          html.FontSize("12"),
        ],
        [value.label]
      ),
    ]
  );
};
const chartSeries = <Message>(
  configuration: Readonly<{
    currency: Spending["buckets"][number]["moneyGroups"][number]["currency"];
    data: Spending;
    context: Context;
    html: HtmlBuilder<Message>;
  }>
): Html => {
  const { currency, data, context, html } = configuration;
  const values = data.buckets.map((bucket) => ({
    label: bucketLabel(bucket.key),
    money: bucket.moneyGroups.find((group) => group.currency === currency)?.outflow ?? {
      amount: BigDecimal.make(0n, 0),
      currency,
    },
  }));
  const geometry = moneySeriesGeometry(values.map(({ money }) => money.amount));
  const step = chartWidth / Math.max(1, values.length);
  return html.section(
    [html.AriaLabel(`Serie ${currency}`), html.Class("grid gap-2")],
    [
      html.p([html.Class("text-sm font-medium")], [`${currency} · Gastos`]),
      html.svg(
        [
          html.ViewBox(`0 0 ${chartWidth} ${chartHeight}`),
          html.Role("img"),
          html.AriaLabel(`Gastos en ${currency}`),
          html.Class("h-48 w-full"),
        ],
        values.map((value, index) =>
          chartBar({
            html,
            value,
            height: (geometry[index] ?? 0) * plotHeight,
            step,
            index,
            context,
          })
        )
      ),
      html.dl(
        [html.Class("sr-only")],
        values.flatMap(({ label, money }) => [
          html.dt([], [label]),
          html.dd([], [formatMoney({ money, locale: context.locale })]),
        ])
      ),
    ]
  );
};
const spendingChart = <Message>(
  data: Spending,
  context: Context,
  html: HtmlBuilder<Message>
): Html => {
  const currencies = Array.from(
    new Set(
      data.buckets.flatMap(({ moneyGroups }) =>
        moneyGroups
          .filter(({ outflow }) => BigDecimal.isPositive(outflow.amount))
          .map(({ currency }) => currency)
      )
    )
  ).sort();
  return currencies.length === 0
    ? empty("No hay transacciones en este periodo", html)
    : html.div(
        [html.Class("grid gap-5")],
        currencies.map((currency) => chartSeries({ currency, data, context, html }))
      );
};
const budgetStatus = (
  data: Extract<Budget, { availability: "available" }>,
  context: Context
): string => {
  switch (data.status.type) {
    case "under":
      return `Disponible ${formatMoney({ money: data.status.remaining, locale: context.locale })}`;
    case "reached":
      return "Presupuesto alcanzado";
    case "over":
      return `Excedido por ${formatMoney({ money: data.status.overBy, locale: context.locale })}`;
  }
};
const budgetBar = <Message>(data: Budget, context: Context, html: HtmlBuilder<Message>): Html => {
  if (data.availability === "missing-budget") {
    return html.div(
      [],
      [
        empty("No hay presupuesto configurado", html),
        html.p([], [`${data.category.label} · ${data.currency}`]),
      ]
    );
  }
  const progress = moneyProgressGeometry({ spent: data.spent, cap: data.cap });
  return html.div(
    [html.Class("grid gap-4")],
    [
      html.p([], [`${data.category.label} · ${data.currency}`]),
      html.div(
        [html.Class("flex justify-between gap-3 tabular-nums")],
        [
          html.span([], [formatMoney({ money: data.spent, locale: context.locale })]),
          html.span([], [formatMoney({ money: data.cap, locale: context.locale })]),
        ]
      ),
      html.div(
        [
          html.Role("progressbar"),
          html.AriaLabel(`Presupuesto ${data.category.label}`),
          html.AriaValuemin(0),
          html.AriaValuemax(100),
          html.AriaValuenow(progress),
          html.AriaValuetext(budgetStatus(data, context)),
          html.Class("h-2 overflow-hidden rounded bg-muted"),
        ],
        [html.div([html.Class("h-full bg-primary"), html.Style({ width: `${progress}%` })])]
      ),
      html.p([html.Class("text-sm text-muted-foreground")], [budgetStatus(data, context)]),
    ]
  );
};
const transactionList = <Message>(
  data: Transactions,
  context: Context,
  html: HtmlBuilder<Message>
): Html => {
  if (data.transactions.length === 0) return empty("No hay transacciones para mostrar", html);
  const formatter = new Intl.DateTimeFormat(context.locale, {
    day: "2-digit",
    month: "short",
    timeZone: context.timeZone,
  });
  return html.table(
    [html.AriaLabel("Transacciones del Widget"), html.Class("w-full text-sm")],
    [
      html.thead(
        [],
        [
          html.tr(
            [],
            [
              html.th([], ["Contraparte"]),
              html.th([], ["Tipo"]),
              html.th([html.Class("text-right")], ["Monto"]),
            ]
          ),
        ]
      ),
      html.tbody(
        [],
        data.transactions.map((transaction) =>
          html.tr(
            [html.Key(transaction.id), html.Class("border-b")],
            [
              html.td(
                [html.Class("py-3")],
                [
                  html.span(
                    [],
                    [Option.getOrElse(transaction.counterparty, () => "Sin contraparte")]
                  ),
                  html.span(
                    [html.Class("block text-xs text-muted-foreground")],
                    [
                      `${transaction.category.label} · ${formatter.format(transaction.occurredAt.epochMilliseconds)}`,
                    ]
                  ),
                ]
              ),
              html.td([], [transaction.direction === "inflow" ? "Ingreso" : "Gasto"]),
              html.td(
                [html.Class("text-right tabular-nums")],
                [formatMoney({ money: transaction.money, locale: context.locale })]
              ),
            ]
          )
        )
      ),
    ]
  );
};
const customMetric = <Message>(data: Metric, context: Context, html: HtmlBuilder<Message>): Html =>
  data.moneyGroups.length === 0
    ? empty("No hay transacciones para calcular", html)
    : html.div(
        [html.Class("grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4")],
        data.moneyGroups.map((group) =>
          html.section(
            [html.Key(group.currency), html.Class("rounded-lg border p-4")],
            [
              html.p([], [group.currency]),
              html.dl(
                [html.Class("mt-4 grid gap-3")],
                [
                  html.dt([], ["Ingresos"]),
                  html.dd(
                    [html.Class("break-words text-xl tabular-nums")],
                    [formatMoney({ money: group.inflow, locale: context.locale })]
                  ),
                  html.dt([], ["Gastos"]),
                  html.dd(
                    [html.Class("break-words text-xl tabular-nums")],
                    [formatMoney({ money: group.outflow, locale: context.locale })]
                  ),
                ]
              ),
            ]
          )
        )
      );
/** Projects all canonical Widget result variants with exact Money labels and bounded SVG geometry. */
export const widgetContent = <Message>({
  view,
  context,
  html,
}: Readonly<{ view: DashboardWidgetView; context: Context; html: HtmlBuilder<Message> }>): Html => {
  const { result } = view;
  if ("buckets" in result) return spendingChart(result, context, html);
  if ("availability" in result) return budgetBar(result, context, html);
  if ("transactions" in result) return transactionList(result, context, html);
  return customMetric(result, context, html);
};
