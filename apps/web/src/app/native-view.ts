import { Match, Option } from "effect";
import type { Mount } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import {
  Cancel01Icon,
  CreditCardIcon,
  Home01Icon,
  Menu01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { fidyLogoUrl } from "@/ui/brand";
import { icon } from "@/ui/icon";
import { buttonVariants } from "@/ui/button-variants";
import { Message, type Model } from "./native-model";
import { type AppRoute, isSignedRoute, publicPage } from "./native-routes";

export type ApplicationMounts = Readonly<{
  page: (
    args: Readonly<{
      route: AppRoute;
      epoch: number;
    }>
  ) => Mount.MountAction<Message>;
  agent: (
    args: Readonly<{
      epoch: number;
    }>
  ) => Mount.MountAction<Message>;
  navigation: () => Mount.MountAction<Message>;
  closePopup: () => Mount.MountAction<Message>;
}>;
type ViewConfiguration = Readonly<{
  model: Model;
  html: HtmlBuilder<Message>;
  mounts: ApplicationMounts;
}>;
const settings = [
  ["/settings/email", "Correo", "Email"],
  ["/settings/pats", "Tokens personales (PAT)", "PATs"],
  ["/settings/agents", "Agentes conectados", "Agents"],
  ["/settings/recovery", "Recuperación", "Recovery"],
] as const;
const navigation = ({ model, html, mounts }: ViewConfiguration): Html =>
  html.nav(
    [html.AriaLabel("Aplicación"), html.Class("flex min-w-0 flex-1 flex-col gap-2 px-3 pb-3")],
    [
      ...[
        {
          href: "/app/dashboard",
          label: "Tablero",
          tag: "Dashboard",
          data: Home01Icon,
        },
        {
          href: "/app/transactions",
          label: "Transacciones",
          tag: "Transactions",
          data: CreditCardIcon,
        },
      ].map(({ href, label, tag, data }) =>
        html.a(
          [
            html.Key(href),
            html.Href(href),
            html.Class(
              `flex min-h-12 shrink-0 items-center gap-4 rounded-md px-4 py-3 text-base hover:bg-muted ${model.route._tag === tag ? "bg-secondary text-secondary-foreground font-medium" : "text-muted-foreground"}`
            ),
            ...(model.route._tag === tag ? [html.Attribute("aria-current", "page")] : []),
          ],
          [
            icon({
              html,
              data,
              size: 24,
              className: "",
            }),
            label,
          ]
        )
      ),
      settingsNavigation({
        model,
        html,
        mounts,
      }),
      html.button(
        [
          html.Type("button"),
          html.Disabled(model.logout === "Pending"),
          html.OnClick(Message.ClickedLogout()),
          html.Class(
            buttonVariants({
              variant: "ghost",
              className: "justify-start md:mt-auto",
            })
          ),
        ],
        [model.logout === "Pending" ? "Cerrando sesión…" : "Cerrar sesión"]
      ),
    ]
  );
const compactNavigation = (configuration: ViewConfiguration): ReadonlyArray<Html> => {
  const { html } = configuration;
  return [
    html.div(
      [html.Class("px-5 md:hidden")],
      [
        html.button(
          [
            html.Type("button"),
            html.Popovertarget("signed-in-navigation"),
            html.AriaLabel("Menú de navegación"),
            html.Class(
              buttonVariants({
                variant: "outline",
                size: "icon",
              })
            ),
          ],
          [
            icon({
              html,
              data: Menu01Icon,
              size: 24,
              className: "signed-in-menu-bars",
            }),
            icon({
              html,
              data: Cancel01Icon,
              size: 24,
              className: "signed-in-menu-close",
            }),
          ]
        ),
      ]
    ),
    html.div(
      [
        html.Id("signed-in-navigation"),
        html.Class("signed-in-compact-navigation"),
        html.Popover("auto"),
      ],
      [navigation(configuration)]
    ),
  ];
};
const failedLogout = (html: HtmlBuilder<Message>): Html =>
  html.div(
    [
      html.Role("alert"),
      html.Class("m-3 rounded-xl border border-destructive p-4 text-destructive"),
    ],
    [
      html.p([html.Class("font-semibold")], ["No pudimos confirmar el cierre de sesión"]),
      html.p([], ["Revisa tu conexión e intenta cerrar sesión de nuevo."]),
    ]
  );
const pageHost = ({ model, html, mounts }: ViewConfiguration): Html =>
  html.div([
    html.Id("route-page"),
    html.Key(JSON.stringify(model.route)),
    html.OnMount(
      mounts.page({
        route: model.route,
        epoch: model.epoch,
      })
    ),
  ]);
const signedShell = (configuration: ViewConfiguration): Html => {
  const { model, html, mounts } = configuration;
  return html.div(
    [
      html.Key(`signed-${model.epoch}`),
      html.Class("signed-in-theme min-h-svh bg-background md:flex"),
      html.OnMount(mounts.navigation()),
    ],
    [
      html.aside(
        [
          html.Class(
            "signed-in-sidebar flex items-center justify-between border-b bg-muted/30 md:sticky md:top-0 md:h-svh md:w-60 md:flex-none md:flex-col md:items-stretch md:border-r md:border-b-0"
          ),
        ],
        [
          html.a(
            [
              html.Href("/app/dashboard"),
              html.Class("flex shrink-0 flex-col items-start gap-2 px-6 py-4"),
            ],
            [
              html.span(
                [
                  html.Class(
                    "inline-flex h-[54px] w-[94px] shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-black"
                  ),
                ],
                [html.img([html.Class("h-auto w-[76px]"), html.Src(fidyLogoUrl), html.Alt("Fidy")])]
              ),
              html.span(
                [html.Class("hidden text-xs text-muted-foreground md:block")],
                ["Tu dinero, más claro"]
              ),
            ]
          ),
          html.div([html.Class("hidden min-h-0 flex-1 md:flex")], [navigation(configuration)]),
          ...compactNavigation(configuration),
          ...(model.logout === "Failed" ? [failedLogout(html)] : []),
        ]
      ),
      html.div(
        [html.Class("min-w-0 flex-1")],
        [
          pageHost(configuration),
          html.div([
            html.Id("hosted-agent"),
            html.Key(`agent-${model.epoch}`),
            html.OnMount(
              mounts.agent({
                epoch: model.epoch,
              })
            ),
          ]),
        ]
      ),
    ]
  );
};
const expired = (html: HtmlBuilder<Message>): Html =>
  html.main(
    [html.Class("flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12")],
    [
      html.div(
        [
          html.Role("alert"),
          html.Class("max-w-md rounded-xl border border-destructive p-4 text-destructive"),
        ],
        [
          html.h1([html.Class("font-semibold")], ["Sesión vencida"]),
          html.p([], ["Tu sesión venció. Inicia sesión de nuevo."]),
          html.a([html.Href("/auth/pair"), html.Class("underline")], ["Iniciar sesión"]),
        ]
      ),
    ]
  );
const callback = ({ model, html, mounts }: ViewConfiguration): Html =>
  html.main(
    [html.OnMount(mounts.closePopup())],
    [
      html.p([], ["Puedes volver a la ventana de Fidy para continuar."]),
      html.a(
        [html.Href(model.route._tag === "GoogleReturn" ? "/auth/google" : "/auth/microsoft")],
        ["Iniciar sesión"]
      ),
    ]
  );
const content = (configuration: ViewConfiguration): Html => {
  const { model, html } = configuration;
  if (isSignedRoute(model.route)) {
    return model.authentication === "expired" ? expired(html) : signedShell(configuration);
  }
  if (model.route._tag === "GoogleReturn" || model.route._tag === "MicrosoftReturn") {
    return callback(configuration);
  }
  return html.div([html.Key(`standalone-${model.epoch}`)], [pageHost(configuration)]);
};
const featureTitles = {
  transacciones: "Transacciones",
  presupuestos: "Presupuestos",
  asistente: "Asistente",
  tablero: "Dashboard",
  insights: "Hallazgos",
  agentes: "Tus agentes",
};
export const pageTitle = (route: AppRoute): string =>
  Match.value(route).pipe(
    Match.tag("Home", () => "Fidy — Tu plata, más clara"),
    Match.tag("Privacy", () => "Política de privacidad — Fidy"),
    Match.tag("Cookies", () => "Cookies y almacenamiento — Fidy"),
    Match.tag("Terms", () => "Términos de servicio — Fidy"),
    Match.tag("Feature", (route) => `${featureTitles[route.slug]} — Fidy`),
    Match.orElse(() => "Fidy")
  );
/** The root owns routing and the document while embedded features own their local state. */
export const applicationView = (configuration: ViewConfiguration): Document => {
  const page = publicPage(configuration.model.route);
  return {
    title: pageTitle(configuration.model.route),
    lang: "es-CO",
    ...Option.match(page, {
      onNone: () => ({}),
      onSome: (path) => ({
        canonical: `https://app.fidyapp.com${path}`,
      }),
    }),
    body: content(configuration),
  };
};
const settingsNavigation = (configuration: ViewConfiguration): Html => {
  const { html, model } = configuration;
  return html.details(
    [html.Class("shrink-0")],
    [
      html.summary(
        [
          html.Class(
            "flex min-h-12 cursor-pointer list-none items-center gap-4 rounded-md px-4 py-3 text-base text-muted-foreground hover:bg-muted"
          ),
        ],
        [
          icon({
            html,
            data: Settings01Icon,
            size: 24,
            className: "",
          }),
          "Ajustes",
        ]
      ),
      html.div(
        [html.Class("flex flex-col gap-1 py-2 pl-4")],
        settings.map(([href, label, tag]) =>
          html.a(
            [
              html.Key(href),
              html.Href(href),
              html.Class(
                `rounded-md px-4 py-2 text-sm hover:bg-muted${model.route._tag === tag ? " bg-secondary text-secondary-foreground" : ""}`
              ),
              ...(model.route._tag === tag ? [html.Attribute("aria-current", "page")] : []),
            ],
            [label]
          )
        )
      ),
    ]
  );
};
