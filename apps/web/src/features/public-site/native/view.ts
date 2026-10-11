import { Option } from "effect";
import type { Html } from "foldkit/html";
import { PublicHome } from "./home";
import { CookiesPolicy } from "@/features/public-site/native/legal/cookies";
import { PrivacyPolicy } from "@/features/public-site/native/legal/privacy-policy";
import { Terms } from "@/features/public-site/native/legal/terms";
import { PublicSiteNotFound } from "./not-found";
import { detailViews } from "@/features/public-site/native/landing/detail-content";
import { features } from "@/features/public-site/native/landing/feature-content";
import { PublicMetadata } from "./metadata";
import type { ViewConfiguration, ViewContent } from "./model";

const documentContent = (configuration: ViewConfiguration): ViewContent => {
  switch (configuration.model.page) {
    case "/politica":
      return PrivacyPolicy(configuration);
    case "/cookies":
      return CookiesPolicy(configuration);
    case "/terminos":
      return Terms(configuration);
    default:
      return PublicSiteNotFound(configuration);
  }
};
const detailContent = (
  configuration: ViewConfiguration,
  detail: Option.Option<(configuration: ViewConfiguration) => ViewContent>
): ViewContent => (Option.isNone(detail) ? [] : detail.value(configuration));
const marketing = (configuration: ViewConfiguration, index: number): ViewContent => {
  const feature = features[index];
  const detail = Option.fromUndefinedOr(detailViews[index]);
  const home = configuration.model.page === "/";
  return [
    ...PublicMetadata({
      noIndex: false,
      ...configuration,
      title: home ? "Fidy — Tu plata, más clara" : `${feature?.label} — Fidy`,
      path: configuration.model.page,
      description: home
        ? "Entiende en qué se va tu plata y planea lo que viene. Lleva tus finanzas desde WhatsApp, la web o tu agente de IA."
        : `Explora ${feature?.label} en Fidy: tus finanzas personales con contexto y control.`,
    }),
    ...(home ? PublicHome(configuration) : detailContent(configuration, detail)),
  ];
};
export const publicView = (configuration: ViewConfiguration): Html => {
  const { html, model, mounts } = configuration;
  const index = features.findIndex((feature) => model.page === `/funciones/${feature.slug}`);
  const landing = model.page === "/" || index >= 0;
  return html.div(
    [
      html.Key(model.page),
      html.Class(
        landing
          ? `fidy-landing variant-a${index >= 0 ? " feature-detail-open" : ""}`
          : "min-h-svh bg-background text-foreground"
      ),
      html.DataAttribute("theme", model.theme),
      html.OnMount(mounts.motion()),
    ],
    landing
      ? marketing(configuration, index)
      : [
          html.header(
            [html.Class("border-b")],
            [
              html.nav(
                [
                  html.Class("mx-auto flex max-w-3xl items-center justify-between px-6 py-5"),
                  html.AriaLabel("Principal"),
                ],
                [
                  html.a(
                    [html.Class("font-heading text-xl font-semibold"), html.Href("/")],
                    ["fidy"]
                  ),
                  html.a(
                    [
                      html.Class("text-sm text-muted-foreground hover:text-foreground"),
                      html.Href("/politica"),
                    ],
                    ["Política de privacidad"]
                  ),
                ]
              ),
            ]
          ),
          ...documentContent(configuration),
        ]
  );
};
