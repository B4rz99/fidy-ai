import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";

export const PhoneContent = (
  configuration: ViewConfiguration & {
    conversation: ViewContent;
    controls: ViewContent;
  }
): ViewContent => {
  const html = configuration.html;
  const { controls } = configuration;
  return [
    " ",
    html.div([html.Class("demo-shell")], [heroStageViewPart(configuration), ...controls]),
    " ",
  ];
};
const heroStageViewPart = (
  configuration: ViewConfiguration & {
    conversation: ViewContent;
    controls: ViewContent;
  }
): Html => {
  const html = configuration.html;
  const { conversation } = configuration;
  return html.div(
    [html.Class("hero-stage")],
    [
      html.div([html.Class("halo")], []),
      html.span([html.Class("coin"), html.Attribute("aria-hidden", String("true"))], ["$"]),
      html.div(
        [html.Class("phone")],
        [
          html.div([html.Class("phone-top")], [html.span([], ["9:41"]), html.span([], ["●●● ▰"])]),
          html.div(
            [html.Class("chat-head")],
            [
              html.span([html.Attribute("aria-hidden", String("true"))], ["‹"]),
              html.span([html.Class("avatar")], ["f"]),
              html.div(
                [],
                [html.strong([], ["fidy"]), html.small([], ["Tu asistente · WhatsApp"])]
              ),
            ]
          ),
          ...conversation,
          html.div(
            [html.Class("chat-input")],
            [
              html.span([], ["Escribe a Fidy…"]),
              html.span([html.Class("send"), html.Attribute("aria-hidden", String("true"))], ["↑"]),
            ]
          ),
        ]
      ),
      html.div(
        [html.Class("floating-note")],
        [
          html.span([html.Class("note-label")], ["Restaurantes · Octubre"]),
          html.br([]),
          html.strong([], ["$216.000"]),
          " disponibles",
          html.div([html.Class("mini-track")], [html.span([], [])]),
          html.span([html.Class("note-label")], ["64% del presupuesto registrado"]),
        ]
      ),
    ]
  );
};
