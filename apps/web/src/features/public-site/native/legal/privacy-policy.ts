import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
import { PublicMetadata } from "@/features/public-site/native/metadata";
import policyHtml from "@/features/public-site/legal/policy.html?raw";
import { PublicPageLayout } from "@/features/public-site/native/page-layout";

/** Renders the immutable privacy policy from its source-controlled legal copy. */
export const PrivacyPolicy = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return PublicPageLayout({
    ...configuration,
    layout: "document",
    children: [
      ...PublicMetadata({
        noIndex: false,
        ...configuration,
        title: "Política de privacidad — Fidy",
        path: "/politica",
        description:
          "Consulta cómo Fidy trata tus datos personales, sus proveedores, conservación y tus derechos en Colombia.",
      }),
      html.article([html.Class("policy flex flex-col gap-4"), html.InnerHTML(policyHtml)], []),
    ],
  });
};
