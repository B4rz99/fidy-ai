import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { maximumAtomicBatchCalls } from "@/transport/client";
import { buttonVariants } from "@/ui/button-variants";
import { categoryIllustration } from "./category-illustration";
import {
  dailyLedgerTotal,
  hasTransactionFilters,
  ledgerRows,
  transactionsEditable,
} from "./ledger-presentation";
import { Message, type Model } from "./model";
import type { TransactionListRow } from "./presentation";

type Builder = HtmlBuilder<Message>;
const categoryCell = ({
  row,
  model,
  html,
}: Readonly<{ row: TransactionListRow; model: Model; html: Builder }>): Html => {
  const transaction = model.query.transactions.find((record) => record.id === row.id);
  if (transaction === undefined || model.query.categories.length === 0) {
    return html.span([], [row.categoryLabel]);
  }
  return html.select(
    [
      html.AriaLabel(`Cambiar categoría de ${row.counterpartyLabel}`),
      html.Value(row.categoryId),
      html.Disabled(!transactionsEditable(model) || model.panel !== "Summary"),
      html.Class("max-w-full rounded-md bg-transparent py-1 text-sm"),
      html.OnChange((categoryId) => Message.ChangedCategory({ id: transaction.id, categoryId })),
    ],
    [
      ...(model.query.categories.some((category) => category.id === row.categoryId)
        ? []
        : [
            html.option(
              [html.Value(row.categoryId), html.Selected(true), html.Disabled(true)],
              [row.categoryLabel]
            ),
          ]),
      ...model.query.categories.map((category) =>
        html.option(
          [html.Value(category.id), html.Selected(category.id === row.categoryId)],
          [category.label]
        )
      ),
    ]
  );
};
const identityText = (row: TransactionListRow, html: Builder): Html =>
  html.span(
    [html.Class("min-w-0 flex-1")],
    [
      html.span([html.Class("block break-words")], [row.counterpartyLabel]),
      html.span(
        [html.Class("transaction-category-inline block break-words text-xs text-muted-foreground")],
        [row.categoryLabel]
      ),
    ]
  );
const recordLocked = (model: Model): boolean =>
  model.working || ["Capture", "Bulk"].includes(model.panel);
const identity = (
  configuration: Readonly<{ row: TransactionListRow; model: Model; html: Builder }>
): Html => {
  const { row, model, html } = configuration;
  const selecting = model.panel === "Selecting";
  const checked = model.selection.some((id) => id === row.id);
  const atLimit = model.selection.length >= maximumAtomicBatchCalls && !checked;
  const transaction = model.query.transactions.find((record) => record.id === row.id);
  if (transaction === undefined) return html.td([]);
  const message = selecting
    ? Message.ToggledSelection({ id: transaction.id })
    : Message.Opened({ id: transaction.id });
  return html.td(
    [html.Class("py-3")],
    [
      html.div(
        [html.Class("flex min-w-0 items-center gap-3")],
        [
          selecting
            ? html.input([
                html.Type("checkbox"),
                html.AriaLabel(`Seleccionar ${row.counterpartyLabel}`),
                html.Checked(checked),
                html.Disabled(model.working || atLimit),
                html.OnClick(message),
              ])
            : null,
          html.button(
            [
              html.Type("button"),
              html.Disabled(recordLocked(model) || (selecting && atLimit)),
              html.OnClick(message),
              html.AriaLabel(`Ver transacción ${row.counterpartyLabel}`),
              html.AriaExpanded(Option.contains(model.focus, transaction.id)),
              html.Class("flex w-full min-w-0 items-center gap-3 rounded-md py-1 text-left"),
            ],
            [
              categoryIllustration({ html, label: row.categoryLabel, large: false }),
              identityText(row, html),
            ]
          ),
        ]
      ),
    ]
  );
};
const recordButton = ({
  row,
  model,
  html,
  kind,
}: Readonly<{
  row: TransactionListRow;
  model: Model;
  html: Builder;
  kind: "type" | "amount";
}>): Html => {
  const record = model.query.transactions.find((transaction) => transaction.id === row.id);
  if (record === undefined) return html.span([]);
  return html.button(
    [
      html.Type("button"),
      html.Disabled(model.working || ["Capture", "Bulk"].includes(model.panel)),
      html.OnClick(Message.Opened({ id: record.id })),
      html.AriaLabel(`Ver ${kind === "type" ? "tipo" : "monto"} de ${row.counterpartyLabel}`),
      html.Class(kind === "amount" ? "py-2 text-right tabular-nums" : "py-2"),
    ],
    [kind === "type" ? row.transactionTypeLabel : row.moneyText]
  );
};
const rowView = (
  configuration: Readonly<{ row: TransactionListRow; model: Model; html: Builder }>
): Html => {
  const { row, model, html } = configuration;
  return html.tr(
    [html.Key(row.id), html.Class("border-b")],
    [
      identity(configuration),
      model.categoryVisible
        ? html.td(
            [html.Class("hidden @min-[600px]/ledger:table-cell")],
            [categoryCell(configuration)]
          )
        : null,
      model.typeVisible
        ? html.td(
            [html.Class("hidden @min-[481px]/ledger:table-cell")],
            [recordButton({ ...configuration, kind: "type" })]
          )
        : null,
      html.td(
        [html.Class("text-right tabular-nums")],
        [recordButton({ ...configuration, kind: "amount" })]
      ),
    ]
  );
};
const groups = (model: Model, html: Builder): ReadonlyArray<Html> => {
  const rows = ledgerRows(model);
  const locale = Option.match(model.query.user, {
    onNone: () => "es-CO",
    onSome: (user) => user.locale,
  });
  return Array.from(
    new Set(ledgerRows({ ...model, sort: "default" }).map((row) => row.occurredOnText))
  ).flatMap((date) => {
    const group = rows.filter((row) => row.occurredOnText === date);
    const first = group[0];
    if (first === undefined) return [];
    return [
      html.tr(
        [html.Key(`date-${date}`), html.DataAttribute("date-group", "true")],
        [
          html.td(
            [html.Colspan(4)],
            [
              html.div(
                [
                  html.Class(
                    "flex items-center justify-between gap-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
                  ),
                ],
                [
                  html.span([], [first.dateLabel]),
                  html.span(
                    [html.Class("tabular-nums")],
                    [dailyLedgerTotal({ rows: group, locale })]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
      ...group.map((row) => rowView({ row, model, html })),
    ];
  });
};
const emptyLabel = (model: Model): string => {
  if (!hasTransactionFilters(model.filters)) return "No hay transacciones para mostrar";
  if (model.query.continuation !== "complete") {
    return "No hay coincidencias entre las transacciones cargadas";
  }
  return "No hay transacciones que coincidan con los filtros.";
};
export const transactionLedger = ({
  model,
  html,
  toolbar,
}: Readonly<{ model: Model; html: Builder; toolbar: ReadonlyArray<Html> }>): Html =>
  html.section(
    [
      html.AriaLabel("Transacciones del mes"),
      html.Class("transaction-ledger min-w-0"),
      html.DataAttribute("category-visible", String(model.categoryVisible)),
      html.DataAttribute("type-visible", String(model.typeVisible)),
    ],
    [
      html.div(
        [html.Class("mb-4 flex flex-wrap items-center gap-2")],
        [
          ...toolbar,
          html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants({ variant: "outline" })),
              html.Disabled(!transactionsEditable(model)),
              html.OnClick(Message.SelectMany()),
            ],
            ["Editar varias"]
          ),
        ]
      ),
      ledgerRows(model).length === 0
        ? html.p([], [emptyLabel(model)])
        : html.table(
            [html.AriaLabel("Tabla de transacciones"), html.Class("w-full")],
            [
              html.thead(
                [html.Class("sr-only")],
                [
                  html.tr(
                    [],
                    [
                      html.th([], ["Contraparte"]),
                      model.categoryVisible ? html.th([], ["Categoría"]) : null,
                      model.typeVisible ? html.th([], ["Tipo"]) : null,
                      html.th([], ["Monto"]),
                    ]
                  ),
                ]
              ),
              html.tbody([], groups(model, html)),
            ]
          ),
    ]
  );
