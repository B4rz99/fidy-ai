import type { Html } from "foldkit/html";
import { fidyLogoUrl } from "@/ui/brand";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
import { LaunchButton } from "./registration";
import { ThemeToggle } from "./theme";

const links = [
  ["como", "Cómo funciona"],
  ["funciones", "Funciones"],
  ["precios", "Precios"],
  ["preguntas", "Preguntas frecuentes"],
] as const;
const destinations = ({ html }: ViewConfiguration): ViewContent =>
  links.map(([id, label]) => html.a([html.Key(id), html.Href(`#${id}`)], [label]));
/** Native popover dismissal, focus and Escape remain owned by the browser. */
export const Header = (configuration: ViewConfiguration): ViewContent => [navView(configuration)];
const navView = (configuration: ViewConfiguration): Html => {
  const { html, mounts } = configuration;
  return html.header(
    [html.Class("wrap nav main-nav"), html.OnMount(mounts.navigation())],
    [
      html.a(
        [html.Class("logo"), html.Href("/"), html.AriaLabel("Fidy, inicio")],
        [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
      ),
      html.nav([html.Class("navlinks"), html.AriaLabel("Principal")], destinations(configuration)),
      menuCloseView(configuration),
      html.nav(
        [
          html.Id("compact-navigation"),
          html.Class("compact-navigation"),
          html.Popover("auto"),
          html.AriaLabel("Navegación compacta"),
        ],
        destinations(configuration)
      ),
    ]
  );
};
const menuCloseView = (configuration: ViewConfiguration): Html => {
  const { html } = configuration;
  return html.div(
    [html.Class("navend")],
    [
      html.a([html.Class("textlink"), html.Href("#demo")], ["Ver una conversación"]),
      ...LaunchButton({
        ...configuration,
        dark: false,
        arrow: false,
      }),
      ...ThemeToggle(configuration),
      html.button(
        [
          html.Class("nav-toggle"),
          html.Type("button"),
          html.Popovertarget("compact-navigation"),
          html.AriaLabel("Menú de navegación"),
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
            ],
            [
              html.path([html.Class("menu-bars"), html.D("M4 6h16M4 12h16M4 18h16")]),
              html.path([html.Class("menu-close"), html.D("M6 6l12 12M6 18 18 6")]),
            ]
          ),
        ]
      ),
    ]
  );
};
