import type { Html } from "foldkit/html";
import { Option } from "effect";
import { Message, type ViewConfiguration, type ViewContent } from "../model";
import { features } from "./feature-content";

const lastFeature = features.length - 1;
const nextFeature = (key: string, index: number): Option.Option<number> => {
  switch (key) {
    case "ArrowRight":
      return Option.some((index + 1) % features.length);
    case "ArrowLeft":
      return Option.some((index + lastFeature) % features.length);
    case "Home":
      return Option.some(0);
    case "End":
      return Option.some(lastFeature);
    default:
      return Option.none();
  }
};
const tabs = (configuration: ViewConfiguration): ViewContent => {
  const { html, model, mounts } = configuration;
  return features.map((feature, index) =>
    html.button(
      [
        html.Type("button"),
        html.Key(feature.slug),
        html.Role("tab"),
        html.Id(`feature-tab-${index}`),
        html.AriaControls("feature-panel"),
        html.AriaSelected(model.feature === index),
        html.Tabindex(model.feature === index ? 0 : -1),
        html.OnMount(
          mounts.click({
            kind: "Feature",
            index,
          })
        ),
        html.OnKeyDownFocus((key) =>
          Option.map(nextFeature(key, index), (next) => ({
            focusSelector: `#feature-tab-${next}`,
            message: Message.SelectFeature({
              index: next,
            }),
          }))
        ),
      ],
      [feature.label]
    )
  );
};
/** Keeps one roving tab stop and names the selected preview with its actual tab. */
export const FeatureTabs = (configuration: ViewConfiguration): ViewContent => [
  productFeaturesView(configuration),
];
const productFeaturesView = (configuration: ViewConfiguration): Html => {
  const { html, model, mounts } = configuration;
  const feature = features[model.feature];
  return html.section(
    [html.Class("section wrap product-features"), html.Id("funciones")],
    [
      html.div(
        [html.Class("section-head")],
        [
          html.h2([], ["De registrar tu plata, ", html.br([]), "a entenderla y actuar."]),
          html.p(
            [],
            [
              "Dale contexto a cada gasto, sigue tu presupuesto y encuentra lo que merece tu atención.",
            ]
          ),
        ]
      ),
      html.div(
        [
          html.OnMount(mounts.indicator()),
          html.Class("feature-tabs"),
          html.Role("tablist"),
          html.AriaLabel("Funciones de Fidy"),
        ],
        [
          ...tabs(configuration),
          html.span([html.Class("feature-indicator"), html.AriaHidden(true)]),
        ]
      ),
      html.div(
        [
          html.Id("feature-panel"),
          html.Class("feature-panel"),
          html.Role("tabpanel"),
          html.AriaLabelledBy(`feature-tab-${model.feature}`),
          html.Tabindex(0),
          html.Key(`${model.feature}-${model.featureInstant}`),
          ...(model.featureInstant ? [] : [html.OnMount(mounts.preview())]),
        ],
        feature === undefined ? [] : feature.content(configuration)
      ),
    ]
  );
};
