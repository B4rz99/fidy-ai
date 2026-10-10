import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { MountAction } from "foldkit/mount";
import type { AuthenticationProvider } from "@/transport/client";
import { buttonVariants } from "@/ui/components/button-variants";
import { Message, type Model, canContinue } from "./model";

type Builder = HtmlBuilder<Message>;
type Configuration = Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
  cliCode: Option.Option<string>;
  mounts: Readonly<{ popup: () => MountAction<Message>; recovery: () => MountAction<Message> }>;
}>;
const button =
  (html: Builder) =>
  (text: string, message: Message, variant: "default" | "outline" | "ghost" = "default"): Html =>
    html.button(
      [html.Type("button"), html.Class(buttonVariants({ variant })), html.OnClick(message)],
      [text]
    );

const providerChoice = (html: Builder, configuration: Configuration): Html => {
  const search = new URLSearchParams();
  Option.map(configuration.handoffReference, (value) => search.set("handoff", value));
  Option.map(configuration.cliCode, (value) => search.set("cliCode", value));
  const query = search.toString();
  const other = configuration.provider === "google" ? "microsoft" : "google";
  return html.a(
    [
      html.Class("text-center underline"),
      html.Href(`/auth/${other}${query.length > 0 ? `?${query}` : ""}`),
    ],
    [other === "google" ? "Google" : "Microsoft"]
  );
};

const consentNotice = (model: Model, html: Builder): ReadonlyArray<Html> => {
  const disclosure = model.disclosure;
  if (disclosure._tag === "Loading") {
    return [html.p([], ["Cargando información de Consentimiento…"])];
  }
  if (disclosure._tag === "Failed") {
    return [
      html.p([html.Role("alert")], ["No pudimos cargar el Consentimiento."]),
      button(html)("Volver a intentar", Message.ClickedReloadDisclosure(), "outline"),
    ];
  }
  return [
    html.p(
      [html.Class("text-sm")],
      [
        disclosure.text,
        html.br([]),
        html.a(
          [
            html.Class("underline"),
            html.Href(disclosure.policyUrl),
            html.Target("_blank"),
            html.Rel("noopener noreferrer"),
          ],
          ["Política de privacidad"]
        ),
      ]
    ),
    html.label(
      [html.Class("flex gap-2")],
      [
        html.input([
          html.Type("checkbox"),
          html.Checked(model.accepted),
          html.OnChange(() => Message.ToggledConsent()),
        ]),
        "Acepto el tratamiento de datos descrito",
      ]
    ),
  ];
};
const editing = (
  model: Model,
  html: Builder,
  configuration: Configuration
): ReadonlyArray<Html> => {
  const handoff = Option.isSome(configuration.handoffReference);
  return [
    ...(model.intent === "signup" && !handoff ? consentNotice(model, html) : []),
    html.button(
      [
        html.Key("continue"),
        html.Type("button"),
        html.Class(buttonVariants()),
        html.Disabled(!canContinue({ model, handoff })),
        html.OnMount(configuration.mounts.popup()),
        html.OnClick(Message.ClickedContinue()),
      ],
      [`Continuar con ${configuration.provider === "google" ? "Google" : "Microsoft"}`]
    ),
    providerChoice(html, configuration),
    ...(!handoff
      ? [
          button(html)(
            model.intent === "signup" ? "Ya tengo cuenta · Iniciar sesión" : "Crear una cuenta",
            Message.ToggledIntent(),
            "ghost"
          ),
        ]
      : []),
  ];
};
const recovery = (html: Builder, configuration: Configuration): ReadonlyArray<Html> => [
  html.h2([], ["Guarda tu código de recuperación"]),
  html.p(
    [],
    ["Se muestra una sola vez. Guárdalo fuera de Fidy; no lo compartas por WhatsApp ni soporte."]
  ),
  html.p(
    [
      html.Class("rounded border p-4 font-mono"),
      html.AriaLabel("Código de recuperación"),
      html.OnMount(configuration.mounts.recovery()),
    ],
    []
  ),
  button(html)("Lo guardé", Message.ClickedAcknowledge()),
];
const refused = (
  model: Model,
  html: Builder,
  configuration: Configuration
): ReadonlyArray<Html> => [
  html.p(
    [html.Role("alert")],
    [
      model.state.status === "cancelled"
        ? "Cancelaste el acceso."
        : "No se completó el acceso. Puedes iniciar un nuevo intento.",
    ]
  ),
  html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants()),
      html.OnMount(configuration.mounts.popup()),
      html.OnClick(Message.ClickedRetry()),
    ],
    ["Volver a intentar"]
  ),
];
const confirming = (model: Model, html: Builder): ReadonlyArray<Html> =>
  model.state.status === "confirming"
    ? [
        html.output(
          [],
          [
            "Vuelve al chat de WhatsApp y escribe “Estado”. Revisa la cuenta y compara este identificador de asociación:",
          ]
        ),
        html.p(
          [html.AriaLabel("Identificador de asociación"), html.Class("font-mono")],
          [model.state.code]
        ),
        html.p(
          [],
          [
            "Confirma respondiendo al mensaje de revisión en tu chat. Si la cuenta no es la tuya, rechaza la asociación.",
          ]
        ),
        button(html)("Cancelar", Message.ClickedCancel(), "outline"),
      ]
    : [];
const uncertain = (html: Builder, configuration: Configuration): ReadonlyArray<Html> => [
  html.p(
    [html.Role("alert")],
    [
      `No pudimos confirmar el acceso. La cuenta podría haberse creado. Inicia sesión con ${configuration.provider === "google" ? "Google" : "Microsoft"} para comprobarlo. El código de recuperación perdido no se vuelve a mostrar.`,
    ]
  ),
  button(html)("Ir a iniciar sesión", Message.ClickedRestart()),
];
const status = (model: Model, html: Builder, configuration: Configuration): ReadonlyArray<Html> => {
  const render: Record<Model["state"]["status"], () => ReadonlyArray<Html>> = {
    editing: () => editing(model, html, configuration),
    recovery: () => recovery(html, configuration),
    confirming: () => confirming(model, html),
    refused: () => refused(model, html, configuration),
    cancelled: () => refused(model, html, configuration),
    uncertain: () => uncertain(html, configuration),
    waiting: () => [
      html.output([], ["Esperando confirmación…"]),
      button(html)("Cancelar", Message.ClickedCancel(), "outline"),
    ],
    cancelling: () => [html.output([], ["Cancelando…"])],
  };
  return render[model.state.status]();
};

/** Renders public state; the recovery element receives its one-time text only through a scoped Mount. */
export const view = ({
  model,
  html,
  configuration,
}: Readonly<{ model: Model; html: Builder; configuration: Configuration }>): Html =>
  html.div(
    [],
    [
      html.main(
        [
          html.Class("flex min-h-svh items-center justify-center px-4 py-12"),
          html.DataAttribute("authentication-renderer", "foldkit"),
        ],
        [
          html.div(
            [
              html.Class(
                "flex w-full max-w-lg flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-base text-card-foreground ring-1 ring-foreground/10"
              ),
            ],
            [
              html.div(
                [html.Class("grid auto-rows-min items-start gap-1 px-4")],
                [
                  html.h1(
                    [html.Class("font-heading text-lg leading-snug font-semibold")],
                    [model.intent === "signup" ? "Crea tu cuenta" : "Inicia sesión"]
                  ),
                ]
              ),
              html.div(
                [html.Key(model.state.status), html.Class("flex flex-col gap-4 px-4")],
                status(model, html, configuration)
              ),
            ]
          ),
        ]
      ),
    ]
  );
