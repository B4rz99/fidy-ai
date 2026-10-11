import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
/** One illustrative transaction, shown through each supported entry point. */
export const ChannelStory = (configuration: ViewConfiguration): ViewContent => [
  channelStoryViewPart(configuration),
];
const channelStoryViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [
      html.Class("channel-story"),
      html.OnMount(configuration.mounts.channels()),
      html.Attribute(
        "aria-label",
        String("Una transacción de ejemplo, tres formas de consultarla")
      ),
    ],
    [
      html.div(
        [html.Class("channel-card")],
        [
          html.span([html.Class("channel-label")], ["01 · WhatsApp"]),
          html.p([html.Class("channel-message")], ["Pagué $28.000 de almuerzo en Crepes."]),
          html.small([], ["Listo, quedó registrado. ✓"]),
        ]
      ),
      html.span(
        [html.Class("channel-connector"), html.Attribute("aria-hidden", String("true"))],
        ["→"]
      ),
      channelBudgetView(configuration),
      html.span(
        [html.Class("channel-connector"), html.Attribute("aria-hidden", String("true"))],
        ["→"]
      ),
      html.div(
        [html.Class("channel-card")],
        [
          html.span([html.Class("channel-label")], ["03 · Tu agente"]),
          html.p(
            [],
            ["Tu último gasto en Restaurantes fue de ", html.strong([], ["$28.000 en Crepes."])]
          ),
          html.small([], ["Ejemplo con acceso autorizado de solo lectura."]),
        ]
      ),
      html.p(
        [html.Class("channel-caption")],
        ["Datos de ejemplo · El mismo contexto en cada canal."]
      ),
    ]
  );
};
const channelBudgetView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("channel-card")],
    [
      html.span([html.Class("channel-label")], ["02 · Web app"]),
      html.div(
        [html.Class("channel-transaction")],
        [html.strong([], ["Crepes"]), html.strong([], ["− $28.000"])]
      ),
      html.small([], ["Restaurantes · COP"]),
      html.div([html.Class("channel-budget")], [html.span([], [])]),
      html.small([], ["Una transacción. Tu presupuesto actualizado."]),
    ]
  );
};
