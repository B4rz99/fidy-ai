import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";
import { AgentBrands } from "./agent-brands";
import { Footer } from "./footer";
import { LaunchButton } from "./registration";
import { Header } from "./navigation";
import { PhoneDemo } from "./phone-demo";
import { FeatureTabs } from "./feature-tabs";
import { DashboardStory } from "./dashboard-story";
import { ChannelStory } from "./channel-story";
import { Pricing } from "./pricing";

export const HomeContent = (configuration: ViewConfiguration): ViewContent => [
  " ",
  ...Header({
    ...configuration,
  }),
  contentViewPart(configuration),
  " ",
];
const hero = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [html.section([html.Class("hero peach")], [heroGridViewPart(configuration)])];
};
const marketStrip = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.div(
      [html.Class("strip")],
      [
        html.div(
          [html.Class("wrap")],
          [
            html.b([], ["Hecho para tu día a día"]),
            html.span([], ["Gastos con contexto"]),
            html.span([], ["Presupuestos a tu medida"]),
            html.span([], ["Tus propios agentes"]),
          ]
        ),
      ]
    ),
  ];
};
const firstSteps = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [
        html.Class("section wrap first-steps"),
        html.Attribute("aria-labelledby", String("primeros-pasos")),
      ],
      [
        html.div(
          [html.Class("section-head")],
          [
            html.h2([html.Id("primeros-pasos")], ["Empieza con lo que ya sabes."]),
            html.p([], ["No necesitas conectar un banco para empezar a organizar tus finanzas."]),
          ]
        ),
        stepsViewPart(configuration),
      ]
    ),
  ];
};
const waysToUse = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("section wrap"), html.Id("como")],
      [
        html.div(
          [html.Class("section-head")],
          [
            html.h2([], ["Tus finanzas.", " ", html.br([]), "Tres formas de usarlas."]),
            html.p(
              [],
              [
                "Fidy es agent-first: está pensado desde el inicio para que tú y tus agentes trabajen de forma cohesiva y sin fricción con tus finanzas.",
              ]
            ),
          ]
        ),
        ...ChannelStory({
          ...configuration,
        }),
        agentSystemViewPart(configuration),
      ]
    ),
  ];
};
const questions = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("section wrap faq"), html.Id("preguntas")],
      [html.div([], [html.h2([], ["Antes de empezar."])]), actionsViewPart(configuration)]
    ),
  ];
};
const closing = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("closing")],
      [
        html.h2([], ["Tu plata, más clara.", " ", html.br([]), "Con la ayuda que tú eliges."]),
        html.p([], ["Conversa con Fidy, explora la web o trabaja con tu propio agente."]),
        ...LaunchButton({
          ...configuration,
          dark: true,
          arrow: true,
        }),
      ]
    ),
  ];
};
const contentViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.main(
    [
      html.Attribute("itemscope", ""),
      html.Attribute("itemtype", "https://schema.org/SoftwareApplication"),
    ],
    [
      html.meta([html.Attribute("itemprop", "name"), html.Attribute("content", String("Fidy"))]),
      html.meta([
        html.Attribute("itemprop", "applicationCategory"),
        html.Attribute("content", String("FinanceApplication")),
      ]),
      html.meta([
        html.Attribute("itemprop", "operatingSystem"),
        html.Attribute("content", String("Web")),
      ]),
      html.link([html.Attribute("itemprop", "url"), html.Href("https://app.fidyapp.com/")]),
      ...hero(configuration),
      ...marketStrip(configuration),
      ...firstSteps(configuration),
      ...waysToUse(configuration),
      ...FeatureTabs({
        ...configuration,
      }),
      ...DashboardStory({
        ...configuration,
      }),
      ...Pricing({
        ...configuration,
      }),
      ...questions(configuration),
      ...closing(configuration),
      ...Footer({
        ...configuration,
      }),
    ]
  );
};
const heroGridViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("wrap hero-grid")],
    [
      html.div(
        [html.Class("hero-copy")],
        [
          html.h1(
            [],
            [
              "Tu plata,",
              " ",
              html.br([]),
              "más clara.",
              " ",
              html.br([]),
              html.em([], ["Tu vida,", " ", html.br([]), "más tranquila."]),
            ]
          ),
          html.p(
            [],
            [
              "Entiende en qué se va tu plata y planea lo que viene. Lleva tus finanzas desde WhatsApp, la web o tu agente de IA.",
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
              html.a([html.Class("textlink"), html.Href("#como")], ["Así funciona ↓"]),
            ]
          ),
          html.small(
            [html.Class("fine")],
            ["7 días de Fidy Pro sin tarjeta. Tú eliges si te suscribes."]
          ),
        ]
      ),
      html.div(
        [html.Id("demo")],
        [
          ...PhoneDemo({
            ...configuration,
          }),
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
          html.h3([], ["1. Crea tu cuenta."]),
          html.p(
            [],
            [
              "Tu cuenta incluye una prueba de Fidy Pro de 7 días, sin tarjeta. Crear la cuenta no activa una suscripción de pago.",
            ]
          ),
        ]
      ),
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["2. Registra una transacción."]),
          html.p(
            [],
            [
              "Escribe cuánto fue y en qué consistió, desde la web o por WhatsApp. También puedes adjuntar un Excel por WhatsApp para incorporar transacciones, según tu plan.",
            ]
          ),
        ]
      ),
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["3. Decide cómo seguir."]),
          html.p(
            [],
            [
              "Revisa tus cifras y presupuestos durante la prueba. Para continuar con las funciones Pro, elige y autoriza un plan en la sección de suscripción.",
            ]
          ),
          html.a([html.Class("textlink"), html.Href("#precios")], ["Ver planes y precios ↓"]),
        ]
      ),
    ]
  );
};
const agentSystemViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("agent-system")],
    [
      html.div(
        [html.Class("agent-entry")],
        [
          html.h3([], ["Conversa con Fidy."]),
          html.p(
            [],
            [
              "Registra una transacción, consulta tus cifras o revisa un presupuesto conversando con Fidy en WhatsApp.",
            ]
          ),
        ]
      ),
      html.div(
        [html.Class("agent-entry")],
        [
          html.h3([], ["Explora la web app."]),
          html.p(
            [],
            [
              "Revisa los detalles, corrige tus transacciones y organiza un dashboard con lo que quieres tener a mano.",
            ]
          ),
        ]
      ),
      textlinkViewSection(configuration),
    ]
  );
};
const textlinkViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary([html.OnMount(configuration.mounts.disclosure())], ["¿Qué pasa con mis datos?"]),
      html.p(
        [],
        [
          "Usamos los datos que compartes para organizar tus finanzas, responder tus solicitudes y proteger tu acceso. Cloudflare procesa el servicio y el asistente; Kapso y Meta intervienen al usar WhatsApp. Estos proveedores pueden tratar datos fuera de Colombia.",
        ]
      ),
      html.p(
        [],
        [
          "Puedes consultar, corregir o solicitar la eliminación de tus datos y revocar tu autorización. Algunas obligaciones legales y de seguridad pueden exigir conservar información específica. Consulta los plazos, proveedores y derechos en la",
          " ",
          html.a([html.Class("textlink"), html.Href("/politica")], ["política de privacidad"]),
          " ",
          "o escribe a",
          " ",
          html.a(
            [html.Class("textlink"), html.Href("mailto:obarboza@fidyapp.com")],
            ["obarboza@fidyapp.com"]
          ),
          ".",
        ]
      ),
    ]
  );
};
const actionsViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      detailsView(configuration),
      html.details(
        [],
        [
          html.summary(
            [html.OnMount(configuration.mounts.disclosure())],
            ["¿Puedo corregir una transacción?"]
          ),
          html.p(
            [],
            [
              "Sí. Puedes corregir los datos de una transacción si algo quedó mal registrado, como el monto o la categoría. La corrección actualiza esa transacción.",
            ]
          ),
        ]
      ),
      textlinkViewPart(configuration),
      html.details(
        [],
        [
          html.summary(
            [html.OnMount(configuration.mounts.disclosure())],
            ["¿Necesito tener mi propio agente?"]
          ),
          html.p(
            [],
            [
              "No. Puedes conversar con Fidy en WhatsApp y usar la web app. Si quieres usar tu propio agente, consulta la guía de conexión y la disponibilidad de cada opción antes de configurarlo.",
            ]
          ),
        ]
      ),
      detailsViewSectionSection(configuration),
      detailsViewSection(configuration),
      html.details(
        [],
        [
          html.summary([html.OnMount(configuration.mounts.disclosure())], ["¿Cuánto cuesta?"]),
          html.p(
            [],
            [
              "Crear tu cuenta incluye una prueba de Fidy Pro de 7 días sin tarjeta. Después, Fidy Pro cuesta $28.900 COP al mes. También puedes elegir $9.900 COP por semana o $289.900 COP al año.",
            ]
          ),
        ]
      ),
      actionsViewSection(configuration),
    ]
  );
};
const textlinkViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("agent-entry")],
    [
      html.h3(
        [],
        [
          "Conéctalo a ",
          ...AgentBrands({
            ...configuration,
          }),
        ]
      ),
      html.p(
        [],
        [
          "Revisa las opciones de MCP, CLI y API, su disponibilidad y los permisos antes de autorizar a tu agente.",
        ]
      ),
      html.a(
        [html.Class("textlink"), html.Href("/funciones/agentes#conectar")],
        ["Conecta tu agente ↗"]
      ),
    ]
  );
};
const actionsViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary([html.OnMount(configuration.mounts.disclosure())], ["¿Cómo empiezo?"]),
      html.p(
        [],
        [
          "Revisa la autorización de tratamiento de datos, crea tu cuenta y registra tu primera transacción. La prueba comienza al crear tu cuenta; no necesitas conectar un banco ni registrar una tarjeta.",
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
        ]
      ),
    ]
  );
};
const detailsView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary(
        [html.OnMount(configuration.mounts.disclosure())],
        ["¿Qué información tengo que compartir?"]
      ),
      html.p(
        [],
        [
          "Para registrar una transacción, cuéntale a Fidy cuánto fue y en qué consistió. Por ejemplo: “Pagué $28.000 de almuerzo en Crepes”. Las respuestas se basan en lo que hayas registrado; no representan por sí solas todas tus finanzas.",
        ]
      ),
    ]
  );
};
const detailsViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary([html.OnMount(configuration.mounts.disclosure())], ["¿Qué son los hallazgos?"]),
      html.p(
        [],
        [
          "Son señales basadas en tus transacciones, como resúmenes semanales, avisos de presupuesto o patrones de cobros recurrentes. Tus agentes también pueden consultarlos. No representan información que aún no hayas incorporado a Fidy.",
        ]
      ),
    ]
  );
};
const detailsViewSectionSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary(
        [html.OnMount(configuration.mounts.disclosure())],
        ["¿Qué puede hacer mi agente?"]
      ),
      html.p(
        [],
        [
          "Depende de los permisos que le des: consultar transacciones y hallazgos, registrar o corregir transacciones y trabajar con tu dashboard. El acceso tiene vencimiento y puedes revocarlo desde Fidy.",
        ]
      ),
    ]
  );
};
