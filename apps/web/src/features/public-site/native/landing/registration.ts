import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
/** Opens the first-party account signup and returning-login surface. */
export const LaunchButton = (
  configuration: ViewConfiguration & {
    dark: boolean;
    arrow: boolean;
  }
): ViewContent => {
  const html = configuration.html;
  const { dark, arrow } = configuration;
  return [
    html.a(
      [html.Class(dark ? "btn" : "btn green"), html.Href("/auth/google")],
      [
        "Crear mi cuenta ",
        arrow ? html.span([html.Attribute("aria-hidden", String("true"))], ["↗"]) : null,
      ]
    ),
  ];
};
