import { Option } from "effect";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/components/button-variants";
import { categoryIllustration } from "./category-illustration";
import { filteredTransactions } from "./ledger-presentation";
import { Message, type Model } from "./model";
import { presentTransactionRows } from "./presentation";
import { transactionSummary } from "./summary-view";

export type PanelMount = (args: Readonly<{ model: Model }>) => Mount.MountAction<Message>;
const detailIdentity = (model: Model, html: HtmlBuilder<Message>): Html => {
  const record = model.query.transactions.find((transaction) =>
    Option.contains(model.focus, transaction.id)
  );
  if (record === undefined || Option.isNone(model.query.user)) {
    return html.p([], ["Esta transacción ya no aparece en el periodo seleccionado."]);
  }
  const user = model.query.user.value;
  const row = presentTransactionRows({
    transactions: [record],
    categories: model.query.categories,
    locale: user.locale,
    timeZone: user.timeZone,
    counterpartyFallback: "Contraparte no identificada",
  })[0];
  if (row === undefined) return html.div([]);
  return html.div(
    [html.Class("flex flex-col gap-6")],
    [
      html.div(
        [html.Class("flex items-start gap-5 border-b pb-8")],
        [
          categoryIllustration({ html, label: row.categoryLabel, large: true }),
          html.div(
            [],
            [
              html.p([html.Class("text-lg font-semibold")], [row.counterpartyLabel]),
              html.p([html.Class("mt-1 text-3xl font-semibold tabular-nums")], [row.moneyText]),
              html.p([html.Class("mt-1 text-sm text-muted-foreground")], [row.dateLabel]),
            ]
          ),
        ]
      ),
      ...(model.panel === "Detail"
        ? [
            html.dl(
              [html.Class("grid grid-cols-2 gap-4 text-sm")],
              [
                { label: "Tipo", value: row.transactionTypeLabel },
                { label: "Categoría", value: row.categoryLabel },
                { label: "Fecha", value: row.occurredOnText },
                { label: "Zona horaria", value: user.timeZone },
                { label: "Notas", value: Option.getOrElse(record.notes, () => "Sin notas") },
              ].flatMap((fact) => [
                html.dt([html.Class("text-muted-foreground")], [fact.label]),
                html.dd([html.Class("break-words")], [fact.value]),
              ])
            ),
          ]
        : []),
    ]
  );
};
const selection = (model: Model, html: HtmlBuilder<Message>): Html =>
  html.section(
    [html.AriaLabel("Selección de transacciones"), html.Class("flex flex-col gap-5")],
    [
      html.h2([html.Class("text-xl font-semibold")], ["Editar varias transacciones"]),
      html.p([], ["Selecciona las transacciones que quieres corregir."]),
      html.p([html.AriaLive("polite")], [`${model.selection.length} seleccionadas`]),
      html.ul(
        [],
        model.query.transactions
          .filter((record) => model.selection.includes(record.id))
          .map((record) =>
            html.li(
              [html.Key(record.id)],
              [Option.getOrElse(record.counterparty, () => "Contraparte no identificada")]
            )
          )
      ),
      html.button(
        [
          html.Type("button"),
          html.Disabled(model.selection.length === 0),
          html.Class(buttonVariants()),
          html.OnClick(Message.EditSelection()),
        ],
        ["Editar selección"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.OnClick(Message.Close()),
        ],
        ["Cancelar"]
      ),
    ]
  );
type Configuration = Readonly<{
  model: Model;
  html: HtmlBuilder<Message>;
  mount: PanelMount;
  responsive: PanelMount;
}>;
const panelTitle = (model: Model): string => {
  if (model.panel === "Capture") return "Registrar transacción";
  if (model.panel === "Bulk") return "Editar transacciones";
  return "Detalle de la transacción";
};
const panelContents = ({ model, html, mount }: Configuration): ReadonlyArray<Html> => {
  const title = panelTitle(model);
  return [
    html.header(
      [html.Class("mb-6 flex items-center justify-between gap-3")],
      [
        html.h2([html.Id("transaction-panel-title"), html.Class("text-lg font-semibold")], [title]),
        html.button(
          [
            html.Type("button"),
            html.Disabled(model.working),
            html.Class(buttonVariants({ variant: "ghost" })),
            html.OnClick(Message.Close()),
            html.AriaLabel(model.panel === "Capture" ? "Cancelar" : "Cerrar detalle"),
          ],
          ["Cerrar"]
        ),
      ]
    ),
    ["Detail", "Correction"].includes(model.panel) ? detailIdentity(model, html) : null,
    model.panel !== "Detail"
      ? html.div([
          html.Id("transaction-editor"),
          html.Class("mt-6"),
          html.OnMount(mount({ model })),
        ])
      : null,
  ];
};
export const workspacePanel = (
  configuration: Readonly<{
    model: Model;
    html: HtmlBuilder<Message>;
    mount: PanelMount;
    responsive: PanelMount;
  }>
): Html => {
  const { model, html, responsive } = configuration;
  if (Option.isNone(model.query.user)) return html.aside([]);
  const user = model.query.user.value;
  const open = !["Summary", "Selecting"].includes(model.panel);
  return html.aside(
    [
      html.Key(`${model.panel}-${Option.getOrElse(model.focus, () => "none")}`),
      html.Class(
        open
          ? "fixed inset-0 z-50 overflow-y-auto bg-card p-5 xl:sticky xl:inset-auto xl:z-auto xl:top-0 xl:self-start xl:border-l xl:p-6"
          : "border-t bg-card p-5 xl:sticky xl:top-0 xl:self-start xl:border-l xl:p-6"
      ),
      ...(open ? [html.OnMount(responsive({ model }))] : []),
    ],
    [
      model.panel === "Summary"
        ? transactionSummary({
            html,
            transactions: filteredTransactions(model),
            locale: user.locale,
            timeZone: user.timeZone,
            partial: model.query.continuation !== "complete",
          })
        : null,
      model.panel === "Selecting" ? selection(model, html) : null,
      ...(open
        ? [
            html.section(
              [
                html.AriaLabel(
                  model.panel === "Capture" ? "Registro de transacción" : "Detalle de transacción"
                ),
              ],
              panelContents(configuration)
            ),
          ]
        : []),
    ]
  );
};
