import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
import { Footer } from "./footer";
import { AgentConnectionGuide } from "./agent-connection-guide";
import { ThemeToggle } from "./theme";
import { fidyLogoUrl } from "@/ui/brand";
import { LaunchButton } from "./registration";
import { CorrectionDemo } from "./correction-demo";

export const detailViews = [
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      transactionsPageView(configuration),
    ];
  },
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      budgetsPageView(configuration),
    ];
  },
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      assistantPageView(configuration),
    ];
  },
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      dashboardPageView(configuration),
    ];
  },
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      insightsPageView(configuration),
    ];
  },
  (configuration: ViewConfiguration): ViewContent => {
    const html = configuration.html;
    return [
      html.header(
        [html.Class("wrap nav")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.a([html.Class("textlink"), html.Href("/#funciones")], ["← Todas las funciones"]),
          html.div(
            [html.Class("navend")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: false,
              }),
              ...ThemeToggle({
                ...configuration,
              }),
            ]
          ),
        ]
      ),
      agentsPageView(configuration),
    ];
  },
];
const sectionHeadViewPartPartPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("section wrap")],
    [
      html.div(
        [html.Class("section-head")],
        [html.h2([], ["Tus transacciones cuentan una historia."])]
      ),
      html.div(
        [html.Class("steps")],
        [
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Captura a tu ritmo."]),
              html.p(
                [],
                ["Registra una transacción desde la web app o cuéntasela a Fidy en WhatsApp."]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Entiende cada dato."]),
              html.p(
                [],
                [
                  "Consulta el monto, la fecha y la categoría de tus transacciones. Los detalles te ayudan a dar contexto a tus gastos.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Corrige y sigue."]),
              html.p(
                [],
                [
                  "Si un monto o una categoría quedó mal, puedes corregir la misma transacción. No necesitas duplicarla.",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const transactionsBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/presupuestos")],
        [
          html.span([], ["Presupuestos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/asistente")],
        [
          html.span([], ["Asistente"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/tablero")],
        [
          html.span([], ["Tablero"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/insights")],
        [
          html.span([], ["Hallazgos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/agentes")],
        [
          html.span([], ["Tus agentes"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const transactionsPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-transacciones")],
    [
      textlinkView(configuration),
      html.section(
        [
          html.Class("detail-showcase"),
          html.Id("vista"),
          html.Attribute("aria-label", String("Vista ilustrativa de Transacciones")),
        ],
        [
          html.div(
            [html.Class("wrap")],
            [
              ...CorrectionDemo({
                ...configuration,
              }),
              html.p(
                [html.Class("detail-disclosure")],
                ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
              ),
            ]
          ),
        ]
      ),
      sectionHeadViewPartPartPartPartPart(configuration),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), transactionsBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const detailBudgetGridViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("detail-budget-grid")],
    [
      detailBudgetNumbersView(configuration),
      html.article(
        [html.Class("detail-budget-card")],
        [
          html.h3([], ["Mercado"]),
          html.span([], ["Disponible · COP"]),
          html.strong([], ["$280.000"]),
          html.div(
            [html.Class("feature-track")],
            [
              html.i(
                [
                  html.Style({
                    width: "65%",
                  }),
                ],
                []
              ),
            ]
          ),
          html.div(
            [html.Class("detail-budget-numbers")],
            [
              html.span([], ["Registrado", html.b([], ["$520.000"])]),
              html.span([], ["Presupuesto", html.b([], ["$800.000"])]),
            ]
          ),
          html.p([], ["65% del presupuesto mensual registrado"]),
        ]
      ),
      detailBudgetNumbersViewSection(configuration),
    ]
  );
};
const transactionsBenefitsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("section wrap")],
    [
      html.div([html.Class("section-head")], [html.h2([], ["Del monto que eliges, a cómo vas."])]),
      html.div(
        [html.Class("steps")],
        [
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Una categoría, un presupuesto."]),
              html.p(
                [],
                ["Define cuánto quieres destinar a restaurantes, mercado o transporte cada mes."]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Lo registrado cuenta."]),
              html.p(
                [],
                [
                  "El progreso refleja las transacciones de esa categoría y moneda. Lo que aún no has registrado no se incluye.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Ajústalo cuando lo necesites."]),
              html.p(
                [],
                [
                  "Puedes actualizar el monto de tu presupuesto y seguir consultando cuánto llevas desde el asistente.",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const budgetsBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/transacciones")],
        [
          html.span([], ["Transacciones"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/asistente")],
        [
          html.span([], ["Asistente"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/tablero")],
        [
          html.span([], ["Tablero"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/insights")],
        [
          html.span([], ["Hallazgos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/agentes")],
        [
          html.span([], ["Tus agentes"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const budgetsPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-presupuestos")],
    [
      textlinkView2(configuration),
      html.section(
        [
          html.Class("detail-showcase"),
          html.Id("vista"),
          html.Attribute("aria-label", String("Vista ilustrativa de Presupuestos")),
        ],
        [
          html.div(
            [html.Class("wrap")],
            [
              detailBudgetGridViewPart(configuration),
              html.p(
                [html.Class("detail-disclosure")],
                ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
              ),
            ]
          ),
        ]
      ),
      transactionsBenefitsView(configuration),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), budgetsBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const budgetsBenefitsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("section wrap")],
    [
      html.div([html.Class("section-head")], [html.h2([], ["De una pregunta, a algo útil."])]),
      html.div(
        [html.Class("steps")],
        [
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Registra con tus palabras."]),
              html.p(
                [],
                [
                  "“Pagué $28.000 de almuerzo en Crepes”. Dale a Fidy el contexto de la transacción.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Haz la siguiente pregunta."]),
              html.p(
                [],
                ["Consulta cuánto llevas en una categoría o cómo va el presupuesto que definiste."]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Respuestas con contexto."]),
              html.p(
                [],
                [
                  "El asistente se basa en la información disponible en Fidy. Sus respuestas no son una visión completa de todas tus finanzas.",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const assistantBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/transacciones")],
        [
          html.span([], ["Transacciones"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/presupuestos")],
        [
          html.span([], ["Presupuestos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/tablero")],
        [
          html.span([], ["Tablero"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/insights")],
        [
          html.span([], ["Hallazgos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/agentes")],
        [
          html.span([], ["Tus agentes"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const assistantPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-asistente")],
    [
      html.section(
        [html.Class("detail-hero wrap")],
        [
          html.h1([], ["Tu plata también", html.br([]), "se puede conversar."]),
          html.p(
            [],
            [
              "Escribe como hablas. Fidy te ayuda a registrar transacciones y consultar tus cifras desde WhatsApp.",
            ]
          ),
          html.div(
            [html.Class("actions")],
            [
              ...LaunchButton({
                ...configuration,
                dark: false,
                arrow: true,
              }),
              html.a([html.Class("textlink"), html.Href("#vista")], ["Ver el ejemplo ↓"]),
            ]
          ),
        ]
      ),
      detailDisclosureView(configuration),
      budgetsBenefitsView(configuration),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), assistantBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const assistantBenefitsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("section wrap")],
    [
      html.div([html.Class("section-head")], [html.h2([], ["Un espacio que puedes organizar."])]),
      html.div(
        [html.Class("steps")],
        [
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Elige qué ver."]),
              html.p(
                [],
                [
                  "Combina métricas, gastos por categoría, presupuestos y listas de transacciones en tu dashboard.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Dale tu orden."]),
              html.p(
                [],
                ["Reorganiza los widgets para que la información que más consultas tenga su lugar."]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Conserva la perspectiva."]),
              html.p(
                [],
                [
                  "Cada cifra parte de tus transacciones. Consulta el detalle para entender qué hay detrás del total.",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const dashboardBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/transacciones")],
        [
          html.span([], ["Transacciones"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/presupuestos")],
        [
          html.span([], ["Presupuestos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/asistente")],
        [
          html.span([], ["Asistente"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/insights")],
        [
          html.span([], ["Hallazgos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/agentes")],
        [
          html.span([], ["Tus agentes"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const dashboardPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-tablero")],
    [
      textlinkViewSection(configuration),
      detailDisclosureView2(configuration),
      assistantBenefitsView(configuration),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), dashboardBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const insightStreamViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("insight-stream")],
    [
      html.article(
        [],
        [
          html.span([], ["Presupuesto · Restaurantes"]),
          html.h3([], ["Llegaste al 80% de tu presupuesto."]),
          html.p([], ["Has registrado $480.000 de $600.000 este mes. Quedan $120.000."]),
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
      insightCompareView(configuration),
      html.article(
        [],
        [
          html.span([], ["Patrón recurrente"]),
          html.h3([], ["Un cobro que se repite."]),
          html.p(
            [],
            [
              "Varias transacciones de $24.900 con la misma contraparte muestran un patrón. Es una señal en tu historial, no una confirmación de una suscripción activa.",
            ]
          ),
        ]
      ),
    ]
  );
};
const dashboardBenefitsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("section wrap")],
    [
      html.div(
        [html.Class("section-head")],
        [html.h2([], ["Señales para revisar, con contexto."])]
      ),
      html.div(
        [html.Class("steps")],
        [
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Sigue tus presupuestos."]),
              html.p(
                [],
                [
                  "Los avisos identifican cuándo lo registrado alcanza el 80% o el 100% del presupuesto mensual de una categoría.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Mira tu semana."]),
              html.p(
                [],
                [
                  "Los resúmenes semanales reúnen información de tus transacciones y permiten comparar períodos. La cobertura depende de los datos disponibles.",
                ]
              ),
            ]
          ),
          html.article(
            [html.Class("step")],
            [
              html.h3([], ["Compártelos con tu agente."]),
              html.p(
                [],
                [
                  "Tu agente autorizado puede consultar los hallazgos pendientes y usarlos para ayudarte a revisar tus finanzas.",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const insightsBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/transacciones")],
        [
          html.span([], ["Transacciones"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/presupuestos")],
        [
          html.span([], ["Presupuestos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/asistente")],
        [
          html.span([], ["Asistente"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/tablero")],
        [
          html.span([], ["Tablero"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/agentes")],
        [
          html.span([], ["Tus agentes"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const insightsPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-insights")],
    [
      textlinkView3(configuration),
      html.section(
        [
          html.Class("detail-showcase"),
          html.Id("vista"),
          html.Attribute("aria-label", String("Vista ilustrativa de Hallazgos")),
        ],
        [
          html.div(
            [html.Class("wrap")],
            [
              insightStreamViewPart(configuration),
              html.p(
                [html.Class("detail-disclosure")],
                ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
              ),
            ]
          ),
        ]
      ),
      dashboardBenefitsView(configuration),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), insightsBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const ownAgentLayoutViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("own-agent-layout")],
    [
      agentTaskStepView(configuration),
      html.aside(
        [html.Class("agent-grant")],
        [
          html.h3([], ["Tú defines el acceso."]),
          html.dl(
            [],
            [
              html.dt([], ["Destinatario"]),
              html.dd([], ["Mi agente"]),
              html.dt([], ["Permiso del ejemplo"]),
              html.dd([], ["Solo lectura"]),
              html.dt([], ["Vigencia"]),
              html.dd([], ["7 días"]),
            ]
          ),
          html.div(
            [html.Class("agent-scope-note")],
            ["Puede consultar. Este acceso no le permite modificar tus transacciones."]
          ),
          html.p(
            [],
            [
              "Puedes revocar el acceso desde Fidy. Para registrar o modificar información necesita permisos de escritura.",
            ]
          ),
          html.span([], ["Ejemplo de autorización"]),
        ]
      ),
    ]
  );
};
const stepsViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("steps")],
    [
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["El mismo sistema."]),
          html.p(
            [],
            [
              "El asistente de Fidy y tus agentes acceden a las mismas capacidades financieras mediante la API, sujetos a los permisos y condiciones de cada acceso.",
            ]
          ),
        ]
      ),
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["Permisos concretos."]),
          html.p(
            [],
            [
              "Elige acceso de lectura, escritura o dashboard, y una vigencia de 7, 30, 90 o 365 días. Puedes revocarlo desde la web app.",
            ]
          ),
        ]
      ),
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["Una base para tus flujos."]),
          html.p(
            [],
            [
              "Conecta un agente compatible mediante MCP, usa la CLI en tus flujos o integra la API. Tu agente puede consultar información, registrar transacciones o preparar tu dashboard con el acceso que autorices.",
            ]
          ),
        ]
      ),
    ]
  );
};
const agentsBodyView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.a(
        [html.Href("/funciones/transacciones")],
        [
          html.span([], ["Transacciones"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/presupuestos")],
        [
          html.span([], ["Presupuestos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/asistente")],
        [
          html.span([], ["Asistente"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/tablero")],
        [
          html.span([], ["Tablero"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
      html.a(
        [html.Href("/funciones/insights")],
        [
          html.span([], ["Hallazgos"]),
          html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]),
        ]
      ),
    ]
  );
};
const agentsPageView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [html.Class("detail-page detail-agentes")],
    [
      textlinkView4(configuration),
      detailDisclosureViewSection(configuration),
      html.section(
        [html.Class("section wrap")],
        [
          html.div([html.Class("section-head")], [html.h2([], ["Agent-first, en la práctica."])]),
          stepsViewPart(configuration),
        ]
      ),
      ...AgentConnectionGuide({
        ...configuration,
      }),
      html.section(
        [html.Class("detail-explore wrap")],
        [html.h2([], ["Sigue explorando."]), agentsBodyView(configuration)]
      ),
      html.section(
        [html.Class("closing")],
        [
          html.h2([], ["Tu plata, más clara.", html.br([]), "Con la ayuda que tú eliges."]),
          html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
          ...LaunchButton({
            ...configuration,
            dark: true,
            arrow: true,
          }),
        ]
      ),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const textlinkView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("detail-hero wrap")],
    [
      html.h1([], ["De cada transacción,", html.br([]), "al detalle que importa."]),
      html.p(
        [],
        [
          "Una lista para seguir tus transacciones. Un lugar para revisar lo que pasó y corregir lo que haga falta.",
        ]
      ),
      html.div(
        [html.Class("actions")],
        [
          ...LaunchButton({
            ...configuration,
            dark: false,
            arrow: true,
          }),
          html.a([html.Class("textlink"), html.Href("#vista")], ["Ver el ejemplo ↓"]),
        ]
      ),
    ]
  );
};
const detailBudgetNumbersView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [html.Class("detail-budget-card")],
    [
      html.h3([], ["Restaurantes"]),
      html.span([], ["Disponible · COP"]),
      html.strong([], ["$216.000"]),
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
        [html.Class("detail-budget-numbers")],
        [
          html.span([], ["Registrado", html.b([], ["$384.000"])]),
          html.span([], ["Presupuesto", html.b([], ["$600.000"])]),
        ]
      ),
      html.p([], ["64% del presupuesto mensual registrado"]),
    ]
  );
};
const textlinkView2 = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("detail-hero wrap")],
    [
      html.h1([], ["Un presupuesto que", html.br([]), "puedes tener presente."]),
      html.p(
        [],
        [
          "Ponle un monto mensual a cada categoría y consulta cuánto has registrado. Decidir es más fácil cuando tienes los números a mano.",
        ]
      ),
      html.div(
        [html.Class("actions")],
        [
          ...LaunchButton({
            ...configuration,
            dark: false,
            arrow: true,
          }),
          html.a([html.Class("textlink"), html.Href("#vista")], ["Ver el ejemplo ↓"]),
        ]
      ),
    ]
  );
};
const detailDisclosureView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [
      html.Class("detail-showcase"),
      html.Id("vista"),
      html.Attribute("aria-label", String("Vista ilustrativa de Asistente")),
    ],
    [
      html.div(
        [html.Class("wrap")],
        [
          html.div(
            [html.Class("detail-assistant")],
            [
              html.aside(
                [],
                [
                  html.b([], ["fidy"]),
                  html.span([], ["Tu asistente"]),
                  html.p([], ["Una conversación que te ayuda a entender lo que registras."]),
                  html.a(
                    [html.Class("textlink"), html.Href("/funciones/transacciones")],
                    ["Explorar transacciones ↗"]
                  ),
                ]
              ),
              detailTranscriptView(configuration),
            ]
          ),
          html.p(
            [html.Class("detail-disclosure")],
            ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
          ),
        ]
      ),
    ]
  );
};
const detailDisclosureView2 = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [
      html.Class("detail-showcase"),
      html.Id("vista"),
      html.Attribute("aria-label", String("Vista ilustrativa de Tablero")),
    ],
    [
      html.div(
        [html.Class("wrap")],
        [
          html.div(
            [html.Class("detail-dashboard")],
            [
              html.div(
                [html.Class("detail-app-title")],
                [html.b([], ["Mi panorama"]), html.span([], ["Octubre · COP"])]
              ),
              detailWidgetGridView(configuration),
            ]
          ),
          html.p(
            [html.Class("detail-disclosure")],
            ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
          ),
        ]
      ),
    ]
  );
};
const insightCompareView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [],
    [
      html.span([], ["Resumen semanal"]),
      html.h3([], ["Tu semana, con contexto."]),
      html.p(
        [],
        [
          "$312.000 registrados esta semana frente a $280.000 la anterior. Una diferencia de $32.000.",
        ]
      ),
      html.div(
        [html.Class("insight-compare")],
        [
          html.div(
            [],
            [
              html.i(
                [
                  html.Style({
                    width: "90%",
                  }),
                ],
                []
              ),
              html.span([], ["Anterior · $280.000"]),
            ]
          ),
          html.div(
            [],
            [
              html.i(
                [
                  html.Style({
                    width: "100%",
                  }),
                ],
                []
              ),
              html.span([], ["Esta semana · $312.000"]),
            ]
          ),
        ]
      ),
    ]
  );
};
const textlinkView3 = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("detail-hero wrap")],
    [
      html.h1([], ["De tus transacciones,", html.br([]), "a lo que importa."]),
      html.p(
        [],
        [
          "Los hallazgos de Fidy ponen tus cifras en contexto: cómo fue tu semana, cuánto llevas de un presupuesto y qué patrones aparecen en tus transacciones.",
        ]
      ),
      html.div(
        [html.Class("actions")],
        [
          ...LaunchButton({
            ...configuration,
            dark: false,
            arrow: true,
          }),
          html.a([html.Class("textlink"), html.Href("#vista")], ["Ver el ejemplo ↓"]),
        ]
      ),
    ]
  );
};
const agentTaskStepView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("own-agent-task")],
    [
      html.span([], ["Tu petición a tu agente"]),
      html.h3([], ["“Revisa mi semana en Fidy y ayúdame a entender qué cambió.”"]),
      html.div(
        [html.Class("agent-task-step")],
        [
          html.b([], ["Consulta tus transacciones"]),
          html.p([], ["Revisa transacciones y presupuestos con los permisos que autorizaste."]),
        ]
      ),
      html.div(
        [html.Class("agent-task-step")],
        [
          html.b([], ["Lee tus hallazgos"]),
          html.p([], ["Consulta los avisos y resúmenes pendientes del mismo sistema."]),
        ]
      ),
      html.div(
        [html.Class("agent-task-step")],
        [
          html.b([], ["Te devuelve contexto"]),
          html.p([], ["Relaciona esa información para ayudarte a decidir qué revisar."]),
        ]
      ),
    ]
  );
};
const textlinkView4 = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("detail-hero wrap")],
    [
      html.h1([], ["Tus finanzas también", html.br([]), "hablan con tus agentes."]),
      html.p(
        [],
        [
          "Fidy está construido para que tus propios agentes sean una forma de usar el producto. Consulta cómo conectar MCP, CLI o API y qué está disponible antes de autorizar acceso a tus transacciones, presupuestos y hallazgos.",
        ]
      ),
      html.div(
        [html.Class("actions")],
        [
          ...LaunchButton({
            ...configuration,
            dark: false,
            arrow: true,
          }),
          html.a([html.Class("textlink"), html.Href("#conectar")], ["Ver guía de conexión ↓"]),
        ]
      ),
    ]
  );
};
const detailBudgetNumbersViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [html.Class("detail-budget-card")],
    [
      html.h3([], ["Transporte"]),
      html.span([], ["Disponible · COP"]),
      html.strong([], ["$120.000"]),
      html.div(
        [html.Class("feature-track")],
        [
          html.i(
            [
              html.Style({
                width: "60%",
              }),
            ],
            []
          ),
        ]
      ),
      html.div(
        [html.Class("detail-budget-numbers")],
        [
          html.span([], ["Registrado", html.b([], ["$180.000"])]),
          html.span([], ["Presupuesto", html.b([], ["$300.000"])]),
        ]
      ),
      html.p([], ["60% del presupuesto mensual registrado"]),
    ]
  );
};
const textlinkViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("detail-hero wrap")],
    [
      html.h1([], ["Lo importante para ti,", html.br([]), "a primera vista."]),
      html.p(
        [],
        [
          "Organiza tu dashboard con las cifras y las transacciones que quieres tener cerca. Una vista personal de tu información en Fidy.",
        ]
      ),
      html.div(
        [html.Class("actions")],
        [
          ...LaunchButton({
            ...configuration,
            dark: false,
            arrow: true,
          }),
          html.a([html.Class("textlink"), html.Href("#vista")], ["Ver el ejemplo ↓"]),
        ]
      ),
    ]
  );
};
const detailDisclosureViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [
      html.Class("detail-showcase"),
      html.Id("vista"),
      html.Attribute("aria-label", String("Vista ilustrativa de Tus agentes")),
    ],
    [
      html.div(
        [html.Class("wrap")],
        [
          ownAgentLayoutViewPart(configuration),
          html.p(
            [html.Class("detail-disclosure")],
            ["Vista ilustrativa · Datos ficticios en COP · No modifica tu información."]
          ),
        ]
      ),
    ]
  );
};
const detailTranscriptView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("detail-transcript")],
    [
      html.div([html.Class("detail-user")], ["Pagué $28.000 de almuerzo en Crepes."]),
      html.div(
        [html.Class("detail-answer")],
        [
          html.b([], ["Listo, quedó registrado."]),
          html.p([], ["Crepes · Restaurantes · $28.000 COP"]),
        ]
      ),
      html.div([html.Class("detail-user")], ["¿Y cómo va mi presupuesto?"]),
      html.div(
        [html.Class("detail-answer")],
        [
          html.b([], ["Te quedan $216.000 en Restaurantes."]),
          html.p([], ["Has registrado $384.000 de los $600.000 que definiste para este mes."]),
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
        ]
      ),
      html.div(
        [html.Class("detail-composer")],
        [
          "Escribe en tus propias palabras… ",
          html.span([html.Attribute("aria-hidden", String("true"))], ["↑"]),
        ]
      ),
    ]
  );
};
const detailWidgetGridView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("detail-widget-grid")],
    [
      html.article(
        [],
        [
          html.span([], ["Gastos registrados"]),
          html.strong([], ["$1.084.000"]),
          html.small([], ["A partir de tus transacciones"]),
        ]
      ),
      html.article(
        [],
        [
          html.span([], ["Restaurantes disponible"]),
          html.strong([], ["$216.000"]),
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
        ]
      ),
      featureTrackViewSection(configuration),
      featureRecordView(configuration),
    ]
  );
};
const featureTrackViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [html.Class("detail-spending")],
    [
      html.h3([], ["Gastos por categoría"]),
      html.div(
        [html.Class("detail-category")],
        [
          html.span([], ["Mercado"]),
          html.b([], ["$520.000"]),
          html.div(
            [html.Class("feature-track")],
            [
              html.i(
                [
                  html.Style({
                    width: "100%",
                  }),
                ],
                []
              ),
            ]
          ),
        ]
      ),
      featureTrackViewSectionSection(configuration),
      html.div(
        [html.Class("detail-category")],
        [
          html.span([], ["Transporte"]),
          html.b([], ["$180.000"]),
          html.div(
            [html.Class("feature-track")],
            [
              html.i(
                [
                  html.Style({
                    width: "35%",
                  }),
                ],
                []
              ),
            ]
          ),
        ]
      ),
    ]
  );
};
const featureRecordView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [],
    [
      html.h3([], ["Últimas transacciones"]),
      html.div(
        [html.Class("feature-record")],
        [html.span([], ["Crepes", html.small([], ["Restaurantes"])]), html.b([], ["− $28.000"])]
      ),
      html.div(
        [html.Class("feature-record")],
        [html.span([], ["Mercado", html.small([], ["Mercado"])]), html.b([], ["− $156.000"])]
      ),
      html.div(
        [html.Class("feature-record")],
        [html.span([], ["Transporte", html.small([], ["Transporte"])]), html.b([], ["− $12.000"])]
      ),
    ]
  );
};
const featureTrackViewSectionSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("detail-category")],
    [
      html.span([], ["Restaurantes"]),
      html.b([], ["$384.000"]),
      html.div(
        [html.Class("feature-track")],
        [
          html.i(
            [
              html.Style({
                width: "74%",
              }),
            ],
            []
          ),
        ]
      ),
    ]
  );
};
