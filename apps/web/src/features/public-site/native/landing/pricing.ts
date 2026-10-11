import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";
import { LaunchButton } from "./registration";

const prices = [
  {
    label: "Semanal",
    amount: "$9.900",
    period: "semana",
  },
  {
    label: "Mensual",
    amount: "$28.900",
    period: "mes",
  },
  {
    label: "Anual",
    amount: "$289.900",
    period: "año",
  },
] as const;
export const Pricing = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    " ",
    html.section(
      [html.Class("section peach"), html.Id("precios")],
      [pricingLayoutView(configuration)]
    ),
    " ",
  ];
};
const PriceValue = (
  configuration: ViewConfiguration & {
    price: (typeof prices)[number];
  }
): ViewContent => {
  const html = configuration.html;
  const { price } = configuration;
  return [
    html.div(
      [html.Class("price-value"), html.Attribute("aria-live", String("polite"))],
      prices
        .map((option) =>
          configuration.html.div(
            [
              configuration.html.Class("price-frame"),
              configuration.html.Key(option.period),
              configuration.html.DataAttribute("visible", String(option.period === price.period)),
              configuration.html.Attribute("aria-hidden", String(option.period !== price.period)),
            ],
            [
              configuration.html.strong(
                [configuration.html.DataAttribute("price-amount", String(""))],
                [option.amount]
              ),
              configuration.html.span(
                [],
                [
                  " COP / ",
                  configuration.html.span(
                    [configuration.html.DataAttribute("price-period", String(""))],
                    [option.period]
                  ),
                ]
              ),
            ]
          )
        )
        .flat()
    ),
  ];
};
const pricingLayoutView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("wrap pricing-layout")],
    [
      html.div(
        [html.Class("pricing-copy")],
        [
          html.h2([], ["Más claridad.", " ", html.br([]), "A tu ritmo."]),
          html.p(
            [],
            ["Prueba Fidy Pro 7 días sin tarjeta. Después, elige un plan semanal, mensual o anual."]
          ),
          html.ul(
            [],
            [
              html.li([], ["Conversa con tu asistente de finanzas."]),
              html.li([], ["Organiza y consulta tus transacciones."]),
              html.li([], ["Sigue tus presupuestos por categoría."]),
              html.li([], ["Consulta tus cifras en la web app."]),
            ]
          ),
        ]
      ),
      priceCardView(configuration),
    ]
  );
};
const priceCardView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  const price = prices[configuration.model.price] ?? prices[1];
  const instant = configuration.model.priceInstant;
  return html.div(
    [html.Class("price-card"), html.DataAttribute("instant", String(instant))],
    [
      html.h3([], ["Fidy Pro"]),
      html.fieldset(
        [
          html.Class("price-options"),
          html.Attribute("aria-label", String("Periodicidad de cobro")),
        ],
        prices
          .map((option, index) =>
            configuration.html.button(
              [
                configuration.html.Key(option.period),
                configuration.html.Attribute(
                  "aria-pressed",
                  String(option.period === price.period)
                ),
                configuration.html.OnMount(
                  configuration.mounts.click({
                    kind: "Price",
                    index,
                  })
                ),
              ],
              [option.label]
            )
          )
          .flat()
      ),
      ...PriceValue({
        ...configuration,
        price,
      }),
      ...LaunchButton({
        ...configuration,
        dark: false,
        arrow: true,
      }),
      html.p(
        [html.Class("price-terms")],
        [
          "Renovación automática. Puedes cancelar futuras renovaciones y conservar el acceso hasta terminar el período pagado.",
        ]
      ),
    ]
  );
};
