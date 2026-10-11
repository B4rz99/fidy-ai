import type { ViewConfiguration, ViewContent } from "./model";
import { cn } from "@/ui/class-names";

type PublicPageLayoutProps = Readonly<{
  readonly children: ViewContent;
  readonly layout: "centered" | "document";
}>;

/** Provides page geometry owned by the public website surface. */
export const PublicPageLayout = (
  configuration: ViewConfiguration & PublicPageLayoutProps
): ViewContent => {
  const html = configuration.html;
  const { children, layout } = configuration;
  return [
    html.main(
      [
        html.Class(
          cn(
            "mx-auto max-w-3xl px-6",
            layout === "centered" && "flex min-h-[70svh] items-center py-16",
            layout === "document" && "py-12"
          )
        ),
      ],
      [...children]
    ),
  ];
};
