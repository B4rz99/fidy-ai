import { Effect, type Layer, Option, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  type FidyClient,
  RecurringDigestReport,
  RecurringDigestReportParams,
} from "@/transport/client";
import { formatMoney } from "@/transport/money";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/components/button-variants";

const Model = Schema.Struct({
  report: Schema.Option(RecurringDigestReport),
  status: Schema.Literals(["Loading", "Ready", "Failed"]),
});
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  LoadedReport: { report: RecurringDigestReport },
  FailedReport: {},
  ClickedRetry: {},
});
type Message = typeof Message.Type;

const retry = (model: Model, html: HtmlBuilder<Message>): Html =>
  card({
    html,
    className: "",
    title: "Informe no disponible",
    description:
      "Inicia sesión con tu usuario de Fidy para consultar este informe. Si ya lo hiciste, vuelve a intentar.",
    content: [],
    footer: [
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants()),
          html.Disabled(model.status === "Loading"),
          html.OnClick(Message.ClickedRetry()),
        ],
        [model.status === "Loading" ? "Reintentando…" : "Reintentar"]
      ),
    ],
  });
const view = (model: Model, html: HtmlBuilder<Message>): Html => {
  if (Option.isNone(model.report)) {
    return model.status === "Loading" ? html.output([], ["Cargando informe…"]) : retry(model, html);
  }
  const report = model.report.value;
  return card({
    html,
    className: "",
    title: "Patrones históricos de cargos recurrentes",
    footer: [],
    description: `${report.payload.confirmationDay.localDate} · ${report.payload.confirmationDay.timeZone}. Estos patrones no indican que los cargos sigan activos.`,
    content: [
      model.status === "Failed" ? retry(model, html) : null,
      html.ul(
        [html.Class("flex flex-col gap-4"), html.AriaLabel("Todos los patrones confirmados")],
        report.payload.items.map((item) =>
          html.li(
            [html.Key(item.confirmationId), html.Class("flex flex-wrap justify-between gap-2")],
            [
              html.span([], [`${item.counterparty} · mensual`]),
              html.span(
                [html.Class("font-medium tabular-nums")],
                [formatMoney({ locale: report.locale, money: item.money })]
              ),
            ]
          )
        )
      ),
    ],
  });
};

/** Renders every frozen report item as escaped text, with canonical exact Money formatting. */
export const mountRecurringDigest = ({
  container,
  apiClient,
  resources,
  id,
}: Readonly<{
  container: HTMLElement;
  apiClient: FidyClient;
  resources: Layer.Layer<never>;
  id: unknown;
}>): (() => void) => {
  const params = Schema.decodeUnknownOption(RecurringDigestReportParams)({ id });
  const Load = Command.define("LoadRecurringDigest", {
    messages: [Message.LoadedReport, Message.FailedReport],
    execute: Effect.gen(function* () {
      if (Option.isNone(params)) return Message.FailedReport();
      const client = yield* apiClient;
      const response = yield* client.insights.getRecurringDigestReport({ params: params.value });
      return Message.LoadedReport({ report: response.data });
    }).pipe(Effect.catchCause(() => Effect.succeed(Message.FailedReport()))),
  });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      view,
      init: (): Update.Return<Model, Message> => ({
        model: { report: Option.none(), status: "Loading" },
        commands: [Load()],
      }),
      update: (model, message): Update.Return<Model, Message> =>
        Message.match<Update.Return<Model, Message>>(message, {
          LoadedReport: ({ report }) => ({
            model: { report: Option.some(report), status: "Ready" },
          }),
          FailedReport: () => ({ model: { ...model, status: "Failed" } }),
          ClickedRetry: () =>
            model.status === "Loading"
              ? { model }
              : { model: { ...model, status: "Loading" }, commands: [Load()] },
        }),
      crash: {
        view: (_, html) =>
          html.p([html.Role("alert")], ["Informe no disponible. Recarga la página."]),
      },
    })
  );
  return () => handle.dispose();
};
