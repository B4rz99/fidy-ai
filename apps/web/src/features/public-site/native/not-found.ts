import type { ViewConfiguration, ViewContent } from "./model";
import { PublicPageLayout } from "./page-layout";

/** Renders public website not-found behavior inside its shared layout. */
export const PublicSiteNotFound = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return PublicPageLayout({
    ...configuration,
    layout: "centered",
    children: [
      html.div(
        [html.Class("flex flex-col gap-4")],
        [
          html.h1(
            [html.Class("font-heading text-4xl font-semibold tracking-tight")],
            ["Página no encontrada"]
          ),
          html.a(
            [html.Class("text-muted-foreground underline underline-offset-4"), html.Href("/")],
            ["Volver al inicio"]
          ),
        ]
      ),
    ],
  });
};
