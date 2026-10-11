import type { Html } from "foldkit/html";
import type { Mount } from "foldkit";
import type { Message, ViewConfiguration, ViewContent } from "../model";

export const DashboardStory = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    " ",
    html.section(
      [html.Class("section dark-section dashboard-story"), html.Id("claridad")],
      [storyHeadingViewPart(configuration)]
    ),
    " ",
  ];
};
const StoryChat = (
  configuration: ViewConfiguration & {
    recorded: boolean;
    onRecord: Mount.MountAction<Message>;
  }
): ViewContent => [storyChatViewPart(configuration)];
const StoryMetrics = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): ViewContent => [metricsViewPart(configuration)];
const StoryLedger = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): ViewContent => {
  const html = configuration.html;
  const { recorded } = configuration;
  return [
    html.div(
      [html.Class("story-ledger")],
      [
        html.div(
          [html.Class("story-ledger-head")],
          [
            html.strong([], ["Última transacción"]),
            html.span([], ["Categoría"]),
            html.span([], ["Valor"]),
          ]
        ),
        html.div(
          [html.Class("story-row"), html.Attribute("aria-hidden", String(!recorded))],
          [
            html.span(
              [html.Class("story-row-name")],
              ["Crepes", html.small([], ["Almuerzo · hoy"])]
            ),
            html.span([], ["Restaurantes"]),
            html.strong([], ["− $28.000"]),
          ]
        ),
        html.p([html.Class("story-empty")], ["Tu próxima transacción aparecerá aquí."]),
      ]
    ),
  ];
};
const StoryResult = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): ViewContent => {
  const html = configuration.html;
  return [html.div([html.Class("story-result")], [dashboardView(configuration)])];
};
const StoryValue = (
  configuration: ViewConfiguration & {
    recorded: boolean;
    before: string;
    after: string;
  }
): ViewContent => {
  const html = configuration.html;
  const { recorded, before, after } = configuration;
  return [
    html.span(
      [html.Class("story-value")],
      [
        html.span(
          [
            html.Attribute("aria-hidden", String(recorded)),
            html.DataAttribute("visible", String(!recorded)),
          ],
          [before]
        ),
        html.span(
          [
            html.Attribute("aria-hidden", String(!recorded)),
            html.DataAttribute("visible", String(recorded)),
          ],
          [after]
        ),
      ]
    ),
  ];
};
const dashboardView = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("dashboard"), html.Id("story-dashboard")],
    [
      "\n        ",
      html.div(
        [html.Class("dash-top")],
        [
          html.b(
            [],
            [
              "fidy",
              html.span(
                [
                  html.Style({
                    color: "#7cb243",
                  }),
                ],
                ["."]
              ),
            ]
          ),
          html.span([], ["Tus finanzas · Octubre"]),
        ]
      ),
      "\n        ",
      storyDashboardBodyView(configuration),
    ]
  );
};
const storyHeadingViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  const recorded = configuration.model.recorded;
  const instant = configuration.model.storyInstant;
  return html.div(
    [html.Class("wrap")],
    [
      "\n    ",
      html.div(
        [html.Class("story-heading")],
        [
          html.h2([], ["Una transacción.", html.br([]), "Un mismo contexto."]),
          html.p(
            [],
            [
              "Registra con el asistente y revisa el resultado en la web. Tus agentes autorizados pueden consultar esa misma transacción y su efecto en el presupuesto.",
            ]
          ),
        ]
      ),
      "\n    ",
      html.div(
        [
          html.Class("story-demo"),
          html.DataAttribute("recorded", String(recorded)),
          html.DataAttribute("instant", String(instant)),
        ],
        [
          "\n      ",
          ...StoryChat({
            ...configuration,
            recorded,
            onRecord: configuration.mounts.click({
              kind: "Story",
              index: 0,
            }),
          }),
          "\n      ",
          html.div(
            [html.Class("story-arrow"), html.Attribute("aria-hidden", String("true"))],
            ["→"]
          ),
          "\n      ",
          ...StoryResult({
            ...configuration,
            recorded,
          }),
          "\n    ",
        ]
      ),
      "\n  ",
    ]
  );
};
const storyChatViewPart = (
  configuration: ViewConfiguration & {
    recorded: boolean;
    onRecord: Mount.MountAction<Message>;
  }
): Html => {
  const html = configuration.html;
  const { recorded, onRecord } = configuration;
  return html.div(
    [html.Class("story-chat")],
    [
      html.div(
        [html.Class("story-chat-head")],
        [
          html.span([html.Class("avatar")], ["f"]),
          html.div([], [html.strong([], ["fidy"]), html.small([], ["Asistente en WhatsApp"])]),
        ]
      ),
      "\n        ",
      html.div(
        [html.Class("story-message")],
        ["Pagué $28.000 de almuerzo en Crepes.", html.small([], ["Mensaje de ejemplo"])]
      ),
      "\n        ",
      html.div(
        [html.Class("story-reply"), html.Attribute("aria-hidden", String(!recorded))],
        [
          html.strong([], ["Listo, quedó registrado."]),
          html.span([], ["Crepes · Restaurantes", html.br([]), "$28.000 COP"]),
        ]
      ),
      "\n        ",
      html.button(
        [
          html.Class("btn green"),
          html.Id("story-trigger"),
          html.Attribute("aria-controls", String("story-dashboard")),
          html.OnMount(onRecord),
        ],
        [recorded ? "↻ Reiniciar ejemplo" : "Registrar ejemplo"]
      ),
      "\n        ",
      html.small([html.Class("story-note")], ["Pruébalo. Solo cambia esta demostración."]),
      "\n      ",
    ]
  );
};
const metricsViewPart = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): Html => {
  const html = configuration.html;
  const { recorded } = configuration;
  return html.div(
    [html.Class("metrics")],
    [
      html.div(
        [html.Class("metric")],
        [
          html.small([], ["Gastos registrados · COP"]),
          html.strong(
            [html.DataAttribute("story-total", String(""))],
            [
              ...StoryValue({
                ...configuration,
                recorded,
                before: "$1.056.000",
                after: "$1.084.000",
              }),
            ]
          ),
          html.small([], ["Basado en tus transacciones"]),
        ]
      ),
      "\n          ",
      categoryView(configuration),
    ]
  );
};
const storyDashboardBodyView = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): Html => {
  const html = configuration.html;
  const { recorded } = configuration;
  return html.div(
    [html.Class("story-dashboard-body")],
    [
      html.div(
        [html.Class("story-dashboard-heading")],
        [
          html.strong([], ["Tu mes, en perspectiva."]),
          html.span(
            [html.Class("story-badge")],
            [
              ...StoryValue({
                ...configuration,
                recorded,
                before: "Antes del mensaje",
                after: "Ejemplo registrado ✓",
              }),
            ]
          ),
        ]
      ),
      "\n          ",
      ...StoryMetrics({
        ...configuration,
        recorded,
      }),
      "\n          ",
      ...StoryLedger({
        ...configuration,
        recorded,
      }),
      "\n          ",
      html.output(
        [
          html.Class(recorded ? "story-status" : "story-status empty-status"),
          html.Attribute("aria-live", String("polite")),
        ],
        [
          recorded
            ? "Una transacción de $28.000 registrada en Restaurantes. Tu presupuesto ya la incluye."
            : "",
        ]
      ),
      "\n        ",
    ]
  );
};
const categoryView = (
  configuration: ViewConfiguration & {
    recorded: boolean;
  }
): Html => {
  const html = configuration.html;
  const { recorded } = configuration;
  return html.div(
    [html.Class("metric")],
    [
      html.small([], ["Restaurantes · COP"]),
      html.strong(
        [html.DataAttribute("story-category", String(""))],
        [
          ...StoryValue({
            ...configuration,
            recorded,
            before: "$356.000",
            after: "$384.000",
          }),
        ]
      ),
      html.em(
        [html.DataAttribute("story-remaining", String(""))],
        [
          ...StoryValue({
            ...configuration,
            recorded,
            before: "$244.000 disponibles",
            after: "$216.000 disponibles",
          }),
        ]
      ),
      html.div([html.Class("budget-bar")], [html.i([html.Class("story-progress")], [])]),
      html.div(
        [html.Class("category")],
        [html.span([], ["Presupuesto"]), html.span([], ["$600.000"])]
      ),
    ]
  );
};
