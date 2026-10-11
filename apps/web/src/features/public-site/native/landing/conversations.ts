import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";

export const conversations = [
  (configuration: ViewConfiguration): ViewContent => [chatBodyViewPartPartPart(configuration)],
  (configuration: ViewConfiguration): ViewContent => [chatBodyViewPartPartPartPart(configuration)],
  (configuration: ViewConfiguration): ViewContent => [
    chatBodyViewPartPartPartPartPart(configuration),
  ],
];
const chatBodyViewPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("chat-body"), html.Attribute("aria-live", String("polite"))],
    [
      html.div([html.Class("day")], ["Hoy · Conversación de ejemplo"]),
      html.div(
        [html.Class("bubble user")],
        ["Pagué $28.000 de almuerzo en Crepes.", html.span([html.Class("timestamp")], ["9:41 ✓✓"])]
      ),
      html.div(
        [html.Class("bubble")],
        [
          html.strong([], ["Listo, quedó registrado."]),
          html.div(
            [html.Class("receipt")],
            [html.b([], ["$28.000 COP"]), html.br([]), "Crepes · Restaurantes"]
          ),
          html.span([html.Class("timestamp")], ["9:41"]),
        ]
      ),
      html.div(
        [html.Class("bubble user")],
        [
          "¿Cuánto llevo en restaurantes este mes?",
          html.span([html.Class("timestamp")], ["9:42 ✓✓"]),
        ]
      ),
      html.div(
        [html.Class("bubble")],
        [
          "Llevas $384.000 de tu presupuesto de $600.000. Te quedan $216.000.",
          html.span([html.Class("timestamp")], ["9:42"]),
        ]
      ),
    ]
  );
};
const chatBodyViewPartPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("chat-body"), html.Attribute("aria-live", String("polite"))],
    [
      html.div([html.Class("day")], ["Hoy · Conversación de ejemplo"]),
      html.div(
        [html.Class("bubble user")],
        [
          "¿En qué se me ha ido la plata este mes?",
          html.span([html.Class("timestamp")], ["9:41 ✓✓"]),
        ]
      ),
      html.div(
        [html.Class("bubble")],
        [
          html.strong([], ["De lo que has registrado en octubre:"]),
          html.div(
            [html.Class("receipt")],
            [
              "Mercado · $520.000",
              html.br([]),
              "Restaurantes · $384.000",
              html.br([]),
              "Transporte · $180.000",
            ]
          ),
          html.span([html.Class("timestamp")], ["9:41"]),
        ]
      ),
      html.div(
        [html.Class("bubble user")],
        ["Muéstrame restaurantes.", html.span([html.Class("timestamp")], ["9:42 ✓✓"])]
      ),
      html.div(
        [html.Class("bubble")],
        [
          "Tienes 12 transacciones en Restaurantes. La más reciente: $28.000 en Crepes.",
          html.span([html.Class("timestamp")], ["9:42"]),
        ]
      ),
    ]
  );
};
const chatBodyViewPartPartPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("chat-body"), html.Attribute("aria-live", String("polite"))],
    [
      html.div([html.Class("day")], ["Hoy · Conversación de ejemplo"]),
      html.div(
        [html.Class("bubble user")],
        [
          "Quiero un presupuesto de $600.000 al mes para restaurantes.",
          html.span([html.Class("timestamp")], ["9:41 ✓✓"]),
        ]
      ),
      html.div(
        [html.Class("bubble")],
        [
          html.strong([], ["Tu presupuesto está listo."]),
          html.div([html.Class("receipt")], [html.b([], ["Restaurantes · $600.000 COP / mes"])]),
          html.span([html.Class("timestamp")], ["9:41"]),
        ]
      ),
      html.div(
        [html.Class("bubble user")],
        ["¿Cómo voy este mes?", html.span([html.Class("timestamp")], ["9:42 ✓✓"])]
      ),
      html.div(
        [html.Class("bubble")],
        [
          "Has registrado $384.000: el 64% de tu presupuesto mensual.",
          html.span([html.Class("timestamp")], ["9:42"]),
        ]
      ),
    ]
  );
};
