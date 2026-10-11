import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/components/button-variants";
import { Message, type Model } from "./model";
import type { Mounts } from "./mounts";

const history = (model: Model, html: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.view.history.map((entry) =>
    html.p(
      [
        html.Key(entry.id),
        html.Class(
          entry.from === "user"
            ? "ml-8 whitespace-pre-wrap rounded-lg bg-muted p-3"
            : "mr-8 whitespace-pre-wrap p-3"
        ),
      ],
      [entry.text]
    )
  );

const conversation = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html =>
  html.section(
    [
      html.AriaLabel("Conversación con Fidy"),
      html.OnMount(mounts.scroll()),
      html.Class("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"),
    ],
    [
      model.view.empty
        ? html.p([html.Class("text-muted-foreground")], ["¿En qué puedo ayudarte?"])
        : null,
      ...history(model, html),
      Option.match(model.view.reply, {
        onNone: () => null,
        onSome: (reply) =>
          html.p(
            [
              html.Key(`reply-${reply.awaitingVisibility}`),
              html.AriaLabel("Respuesta del agente"),
              html.Class("mr-8 whitespace-pre-wrap p-3"),
              html.OnMount(mounts.visible({ active: model.open && reply.awaitingVisibility })),
            ],
            [reply.text]
          ),
      }),
      model.view.status !== ""
        ? html.p(
            [html.AriaLive("polite"), html.Class("text-xs text-muted-foreground")],
            [model.view.status]
          )
        : null,
      model.view.canCheckProgress
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants()),
              html.OnClick(Message.RequestedWork({ action: "Progress" })),
            ],
            ["Consultar estado"]
          )
        : null,
      model.view.canRetryDelivery
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants()),
              html.OnClick(Message.RequestedWork({ action: "Retry" })),
            ],
            ["Reintentar conexión"]
          )
        : null,
    ]
  );
const composer = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html =>
  html.form(
    [
      html.Class("flex shrink-0 flex-col gap-2 border-t p-4"),
      html.OnSubmit(Message.RequestedWork({ action: "Submit" })),
    ],
    [
      html.label([html.Class("sr-only"), html.For("hosted-message")], ["Mensaje"]),
      html.textarea([
        html.Id("hosted-message"),
        html.Class(
          "max-h-32 min-h-20 w-full resize-none rounded-lg border border-border bg-background p-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ),
        html.Disabled(!model.view.canSubmit),
        html.Required(true),
        html.Placeholder("Escribe tu mensaje…"),
        html.OnMount(mounts.input()),
      ]),
      html.div(
        [html.Class("flex items-center justify-between gap-3")],
        [
          html.p(
            [html.Class("text-xs text-muted-foreground")],
            ["No compartas contraseñas ni datos de tarjetas."]
          ),
          html.button(
            [
              html.Type("submit"),
              html.Class(buttonVariants()),
              html.Disabled(!model.view.canSubmit || !model.hasDraft),
            ],
            ["Enviar"]
          ),
        ]
      ),
    ]
  );
const dialog = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html =>
  html.section(
    [
      html.Id("hosted-dialog"),
      html.Role("dialog"),
      html.AriaLabel("Agente Fidy"),
      html.OnMount(mounts.dialog()),
      html.Class(
        "signed-in-theme fixed right-5 bottom-24 z-50 flex h-[min(36rem,calc(100svh-6rem))] w-[min(25rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      ),
    ],
    [
      html.header(
        [html.Class("flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3")],
        [
          html.div(
            [],
            [
              html.h2([html.Class("font-heading text-lg font-semibold")], ["Agente Fidy"]),
              html.p([html.Class("text-xs")], ["Tu asistente financiero"]),
            ]
          ),
          html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants({ variant: "ghost" })),
              html.AriaLabel("Cerrar chat"),
              html.OnClick(Message.ChangedOpen({ open: false })),
            ],
            ["×"]
          ),
        ]
      ),
      conversation(model, html, mounts),
      html.button(
        [
          html.Type("button"),
          html.AriaLabel("Ir al final de la conversación"),
          html.Class("self-center rounded-full border px-3 text-sm"),
          html.OnMount(mounts.scrollButton()),
        ],
        ["↓"]
      ),
      composer(model, html, mounts),
    ]
  );
/** The conversation owner stays mounted while the chat window is dismissed. */
export const conversationView = ({
  model,
  html,
  mounts,
}: Readonly<{ model: Model; html: HtmlBuilder<Message>; mounts: Mounts }>): Html =>
  html.div(
    [],
    [
      html.button(
        [
          html.Id("hosted-launcher"),
          html.Type("button"),
          html.AriaLabel("Abrir agente Fidy"),
          html.AriaExpanded(model.open),
          html.AriaControls("hosted-dialog"),
          html.Class(
            `${buttonVariants()} fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 shadow-md`
          ),
          html.OnClick(Message.ChangedOpen({ open: !model.open })),
        ],
        ["✦"]
      ),
      model.open ? dialog(model, html, mounts) : null,
    ]
  );
