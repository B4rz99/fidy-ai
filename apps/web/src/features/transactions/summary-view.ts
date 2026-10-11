import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./model";
import { type SummaryProps, currencyFigures, dateRange } from "./summary-presentation";

const summaryLine = (
  html: HtmlBuilder<Message>,
  figure: Readonly<{ label: string; value: string }>
): Html =>
  html.div(
    [html.Class("flex items-start justify-between gap-4 py-2.5")],
    [
      html.dt([html.Class("text-sm text-muted-foreground")], [figure.label]),
      html.dd([html.Class("text-right text-sm font-medium tabular-nums")], [figure.value]),
    ]
  );

export const transactionSummary = (
  configuration: SummaryProps & Readonly<{ html: HtmlBuilder<Message> }>
): Html => {
  const { html, transactions, locale } = configuration;
  const line = (figure: Readonly<{ label: string; value: string }>): Html =>
    summaryLine(html, figure);
  const range = dateRange(configuration);
  const currencies = Array.from(new Set(transactions.map((record) => record.money.currency)));
  const names = new Intl.DisplayNames(locale, { type: "currency" });
  return html.section(
    [html.AriaLabel("Resumen de transacciones"), html.Class("flex flex-col gap-5")],
    [
      html.h2([html.Class("text-xl font-semibold")], ["Resumen"]),
      configuration.partial
        ? html.p(
            [html.Class("text-sm text-muted-foreground")],
            ["Solo transacciones cargadas que coinciden con los filtros."]
          )
        : null,
      html.dl(
        [],
        [
          line({ label: "Total de transacciones", value: String(transactions.length) }),
          ...["inflow", "outflow"].map((direction) =>
            line({
              label: direction === "inflow" ? "Ingresos" : "Gastos",
              value: String(transactions.filter((record) => record.direction === direction).length),
            })
          ),
        ]
      ),
      ...currencies.map((currency) =>
        html.div(
          [html.Key(currency), html.Class("border-t pt-4")],
          [
            currencies.length > 1 ? html.h3([], [names.of(currency) ?? currency]) : null,
            html.dl(
              [],
              currencyFigures({
                transactions: transactions.filter((record) => record.money.currency === currency),
                locale,
              }).map(line)
            ),
          ]
        )
      ),
      html.dl(
        [html.Class("border-t pt-4")],
        [
          line({ label: "Primera transacción", value: range.first }),
          line({ label: "Última transacción", value: range.last }),
        ]
      ),
    ]
  );
};
