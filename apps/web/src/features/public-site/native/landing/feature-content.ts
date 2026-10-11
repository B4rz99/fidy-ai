import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";

export const features = [
  {
    label: "Transacciones",
    slug: "transacciones",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Cada transacción tiene su lugar."]),
            html.p(
              [],
              [
                "Revisa tus transacciones, consulta sus categorías y corrige los datos que necesites. Tú y tus agentes autorizados trabajan con la misma información.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/transacciones")],
              ["Explorar transacciones ↗"]
            ),
          ]
        ),
        html.div([html.Class("feature-art")], [featureWindowView(configuration)]),
        " ",
      ];
    },
  },
  {
    label: "Presupuestos",
    slug: "presupuestos",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Dale un plan a tu mes."]),
            html.p(
              [],
              [
                "Define un presupuesto mensual por categoría y consulta cuánto has registrado. Ten presente cuánto queda antes de tu próxima decisión.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/presupuestos")],
              ["Explorar presupuestos ↗"]
            ),
          ]
        ),
        html.div([html.Class("feature-art")], [featureFootView(configuration)]),
        " ",
      ];
    },
  },
  {
    label: "Asistente",
    slug: "asistente",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Pregúntalo como lo piensas."]),
            html.p(
              [],
              [
                "Conversa con Fidy desde WhatsApp. Registra una transacción, consulta tus gastos o revisa cómo va tu presupuesto, en tus propias palabras.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/asistente")],
              ["Explorar asistente ↗"]
            ),
          ]
        ),
        html.div([html.Class("feature-art")], [featureConversationView(configuration)]),
        " ",
      ];
    },
  },
  {
    label: "Dashboard",
    slug: "tablero",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Tus finanzas, a tu manera."]),
            html.p(
              [],
              [
                "Organiza tu dashboard para tener a mano la información que te importa. Consulta tus cifras y encuentra perspectiva en lo que has registrado.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/tablero")],
              ["Explorar dashboard ↗"]
            ),
          ]
        ),
        html.div([html.Class("feature-art")], [featureWindowViewPart(configuration)]),
        " ",
      ];
    },
  },
  {
    label: "Hallazgos",
    slug: "insights",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Encuentra lo que merece atención."]),
            html.p(
              [],
              [
                "Resúmenes semanales, avisos de presupuesto y patrones recurrentes convierten tus transacciones en contexto. Tu agente también puede consultar estos hallazgos.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/insights")],
              ["Explorar hallazgos ↗"]
            ),
          ]
        ),
        html.div([html.Class("feature-art")], [featureFootView2(configuration)]),
        " ",
      ];
    },
  },
  {
    label: "Tus agentes",
    slug: "agentes",
    content: (configuration: ViewConfiguration): ViewContent => {
      const html = configuration.html;
      return [
        " ",
        html.div(
          [html.Class("feature-copy")],
          [
            html.h3([], ["Tu agente también puede ayudarte."]),
            html.p(
              [],
              [
                "Conecta tu agente mediante MCP, CLI o API para consultar transacciones, revisar hallazgos y ayudarte a organizar tus finanzas. Tú autorizas su acceso.",
              ]
            ),
            html.a(
              [html.Class("textlink"), html.Href("/funciones/agentes")],
              ["Explorar tus agentes ↗"]
            ),
          ]
        ),
        html.div(
          [html.Class("feature-art")],
          [
            html.div(
              [html.Class("feature-window")],
              [
                html.div(
                  [html.Class("feature-window-head")],
                  ["Mi agente ", html.span([], ["Acceso de ejemplo"])]
                ),
                html.div(
                  [html.Class("feature-budget")],
                  [
                    html.span([], ["Consulta tus transacciones y hallazgos"]),
                    html.strong([], ["Solo lectura"]),
                    html.p([], ["MCP · CLI · API", html.br([]), "Acceso autorizado por ti."]),
                  ]
                ),
                html.div(
                  [html.Class("feature-foot")],
                  ["La misma información. Los permisos que tú defines."]
                ),
              ]
            ),
          ]
        ),
        " ",
      ];
    },
  },
];
const featureWindowView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-window")],
    [
      html.div(
        [html.Class("feature-window-head")],
        ["Tus transacciones ", html.span([], ["Octubre"])]
      ),
      html.div(
        [html.Class("feature-record")],
        [
          html.span([], ["Crepes", html.small([], ["Restaurantes · Hoy"])]),
          html.strong([], ["− $28.000"]),
        ]
      ),
      html.div(
        [html.Class("feature-record")],
        [
          html.span([], ["Mercado", html.small([], ["Mercado · Ayer"])]),
          html.strong([], ["− $156.000"]),
        ]
      ),
      html.div(
        [html.Class("feature-record")],
        [
          html.span([], ["Transporte", html.small([], ["Transporte · Ayer"])]),
          html.strong([], ["− $12.000"]),
        ]
      ),
      html.div([html.Class("feature-foot")], ["Los detalles hacen la diferencia."]),
    ]
  );
};
const featureWindowViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-window")],
    [
      html.div([html.Class("feature-window-head")], ["Tus finanzas ", html.span([], ["Octubre"])]),
      featureChartLabelsView(configuration),
    ]
  );
};
const featureFootView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-window")],
    [
      html.div(
        [html.Class("feature-window-head")],
        ["Tu presupuesto ", html.span([], ["Octubre"])]
      ),
      html.div(
        [html.Class("feature-budget")],
        [
          html.span([], ["Restaurantes"]),
          html.strong([], ["$216.000"]),
          html.span([], ["disponibles de $600.000"]),
          html.div(
            [html.Class("feature-track")],
            [
              html.i(
                [
                  html.Style({
                    width: "64%",
                  }),
                ],
                []
              ),
            ]
          ),
          html.div(
            [html.Class("feature-record")],
            [html.span([], ["Registrado"]), html.b([], ["$384.000 · 64%"])]
          ),
        ]
      ),
      html.div([html.Class("feature-foot")], ["Basado en las transacciones registradas."]),
    ]
  );
};
const featureConversationView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-window")],
    [
      html.div([html.Class("feature-window-head")], ["Tu asistente ", html.span([], ["fidy"])]),
      html.div(
        [html.Class("feature-conversation")],
        [
          html.p([], ["¿Cuánto llevo en restaurantes?"]),
          html.div(
            [],
            [
              html.b([], ["Vamos a verlo."]),
              html.p(
                [],
                ["Has registrado $384.000 este mes. Te quedan $216.000 de tu presupuesto."]
              ),
            ]
          ),
          html.span([], ["Todo empieza con una pregunta."]),
        ]
      ),
    ]
  );
};
const featureFootView2 = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-window")],
    [
      html.div([html.Class("feature-window-head")], ["Hallazgos ", html.span([], ["Ejemplo"])]),
      html.div(
        [html.Class("feature-budget")],
        [
          html.span([], ["Restaurantes · Este mes"]),
          html.strong([], ["80% registrado"]),
          html.p([], ["$480.000 de $600.000. Quedan $120.000 en tu presupuesto."]),
          html.div(
            [html.Class("feature-track")],
            [
              html.i(
                [
                  html.Style({
                    width: "80%",
                  }),
                ],
                []
              ),
            ]
          ),
        ]
      ),
      html.div([html.Class("feature-foot")], ["Disponible para consulta por tus agentes."]),
    ]
  );
};
const featureChartLabelsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("feature-budget")],
    [
      html.span([], ["Gastos registrados"]),
      html.strong([], ["$1.084.000"]),
      html.div(
        [
          html.Class("feature-chart"),
          html.Attribute("aria-label", String("Gráfico ilustrativo de gastos semanales")),
        ],
        [
          html.i(
            [
              html.Style({
                height: "38%",
              }),
            ],
            []
          ),
          html.i(
            [
              html.Style({
                height: "66%",
              }),
            ],
            []
          ),
          html.i(
            [
              html.Style({
                height: "49%",
              }),
            ],
            []
          ),
          html.i(
            [
              html.Style({
                height: "85%",
              }),
            ],
            []
          ),
        ]
      ),
      html.div(
        [html.Class("feature-chart-labels")],
        [html.span([], ["Semana 1"]), html.span([], ["Semana 4"])]
      ),
    ]
  );
};
