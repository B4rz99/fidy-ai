import { Message, type ViewConfiguration, type ViewContent, isDark } from "../model";

export const ThemeToggle = ({ html, model }: ViewConfiguration): ViewContent => {
  const dark = isDark(model);
  const label = dark ? "Activar tema claro" : "Activar tema oscuro";
  return [
    html.button(
      [
        html.Class("theme-toggle"),
        html.Type("button"),
        html.OnClick(Message.ToggleTheme()),
        html.AriaLabel(label),
        html.Title(label),
      ],
      [
        html.svg(
          [
            html.AriaHidden(true),
            html.ViewBox("0 0 24 24"),
            html.Fill("none"),
            html.Stroke("currentColor"),
            html.StrokeWidth("1.5"),
            html.StrokeLinecap("round"),
            html.StrokeLinejoin("round"),
          ],
          dark
            ? [html.path([html.D("M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z")])]
            : [
                html.circle([html.Cx("12"), html.Cy("12"), html.R("4")]),
                html.path([
                  html.D(
                    "M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"
                  ),
                ]),
              ]
        ),
      ]
    ),
  ];
};
