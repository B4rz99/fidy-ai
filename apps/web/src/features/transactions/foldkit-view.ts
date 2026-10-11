import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/button-variants";
import { transactionLedger } from "./ledger-view";
import { Message, type Model } from "./model";
import { type PanelMount, workspacePanel } from "./panel-view";
import { workspaceHeader, workspaceToolbar } from "./toolbar-view";

const retry = (
  configuration: Readonly<{ html: HtmlBuilder<Message>; label: string; waiting: boolean }>
): Html => {
  const { html } = configuration;
  return html.div(
    [html.Class("flex flex-col gap-3 p-4")],
    [
      html.p([html.Role("alert")], [configuration.label]),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(configuration.waiting),
          html.OnClick(Message.Refresh()),
        ],
        [configuration.waiting ? "Reintentando…" : "Actualizar historial"]
      ),
    ]
  );
};
const continuationLabel = (state: Model["query"]["continuation"]): string => {
  if (state === "loading") return "Cargando más transacciones…";
  if (state === "failure") return "Reintentar carga de más transacciones";
  return "Cargar más transacciones";
};
const continuationDisabled = (model: Model): boolean =>
  model.query.continuation === "loading" ||
  model.working ||
  model.query.waiting ||
  model.query.stale ||
  !["Summary", "Selecting"].includes(model.panel);
const continuation = (model: Model, html: HtmlBuilder<Message>): Html => {
  const state = model.query.continuation;
  if (state === "complete") return html.div([]);
  return html.div(
    [html.Class("flex flex-col items-start gap-2 px-4 py-4")],
    [
      html.output(
        [html.Class("text-sm text-muted-foreground")],
        [
          `${model.query.transactions.length} transacciones cargadas. Filtros y resumen aplican a las transacciones cargadas.`,
        ]
      ),
      state === "failure"
        ? html.p(
            [html.Role("alert")],
            ["No pudimos cargar más transacciones. Conservamos las transacciones cargadas."]
          )
        : null,
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(continuationDisabled(model)),
          html.OnClick(state === "failure" ? Message.RetryMore() : Message.More()),
        ],
        [continuationLabel(state)]
      ),
    ]
  );
};
const workspaceContent = (
  configuration: Readonly<{
    model: Model;
    html: HtmlBuilder<Message>;
    mount: PanelMount;
    responsive: PanelMount;
  }>
): Html => {
  const { model, html } = configuration;
  return html.div(
    [
      html.Key("workspace"),
      html.Class("grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px]"),
    ],
    [
      html.div(
        [html.Class("min-w-0 px-4 py-6")],
        [
          transactionLedger({ model, html, toolbar: workspaceToolbar(configuration) }),
          continuation(model, html),
        ]
      ),
      workspacePanel(configuration),
    ]
  );
};
export const transactionsView = (
  configuration: Readonly<{
    model: Model;
    html: HtmlBuilder<Message>;
    mount: PanelMount;
    responsive: PanelMount;
  }>
): Html => {
  const { model, html } = configuration;
  return html.main(
    [html.Class("flex w-full flex-col")],
    [
      workspaceHeader(configuration),
      model.noticeTitle === ""
        ? null
        : html.output(
            [html.Key("notice"), html.Role("status"), html.Class("px-4 py-2")],
            [html.strong([], [model.noticeTitle]), html.span([html.Class("block")], [model.notice])]
          ),
      model.query.status === "Loading"
        ? html.section(
            [html.AriaLabel("Cargando transacciones"), html.AriaLive("polite"), html.Class("p-6")],
            ["Cargando transacciones…"]
          )
        : null,
      model.query.status === "Failed"
        ? retry({
            html,
            label: model.query.boundaryFailure
              ? "No pudimos comunicarnos con Fidy"
              : "No pudimos cargar tus transacciones",
            waiting: model.query.waiting,
          })
        : null,
      model.query.stale
        ? retry({
            html,
            label:
              "No pudimos actualizar las transacciones. Mostramos las últimas transacciones disponibles.",
            waiting: model.query.waiting,
          })
        : null,
      model.feedback === ""
        ? null
        : retry({ html, label: model.feedback, waiting: model.query.waiting }),
      model.query.status === "Ready" ? workspaceContent(configuration) : null,
    ]
  );
};
