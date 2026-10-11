import { DateTime, Option } from "effect";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { type PATPairingReview, patScopeCopy } from "@/transport/client";
import { buttonVariants } from "@/ui/button-variants";
import { PairingMessage as Message, type PairingModel } from "./pairing-model";

type Builder = HtmlBuilder<Message>;
const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const details = (review: PATPairingReview, html: Builder): Html =>
  html.dl(
    [html.Class("grid gap-2 sm:grid-cols-[10rem_1fr]")],
    [
      html.dt([], ["Nombre indicado"]),
      html.dd([], [review.recipientLabel]),
      html.dt([], ["Permisos solicitados"]),
      html.dd(
        [],
        review.scopes.map((scope) => html.span([html.Class("mr-2")], [patScopeCopy[scope].label]))
      ),
      html.dt([], ["Vigencia desde la autorización"]),
      html.dd([], [`${review.lifetimeDays} días`]),
      html.dt([], ["Completar la conexión antes de"]),
      html.dd(
        [],
        [
          html.time(
            [html.Datetime(DateTime.formatIso(review.claimBy))],
            [formatter.format(DateTime.toDate(review.claimBy))]
          ),
        ]
      ),
    ]
  );
const reviewView = (model: PairingModel, html: Builder): Html => {
  if (Option.isNone(model.review)) return html.output([], ["Cargando solicitud…"]);
  const busy = model.status === "Approving";
  return html.section(
    [html.Class("flex flex-col gap-5")],
    [
      html.h2([html.Class("text-xl font-semibold")], ["Confirma el acceso"]),
      Option.isSome(model.publicCode)
        ? html.p(
            [],
            [
              "Confirma que este código coincide con tu terminal: ",
              html.strong([html.Class("font-mono")], [model.publicCode.value]),
              ".",
            ]
          )
        : null,
      html.p(
        [],
        [
          "El nombre lo indica el solicitante; no verifica su identidad. Continúa solo si tú iniciaste esta conexión.",
        ]
      ),
      details(model.review.value, html),
      html.div(
        [html.Class("flex justify-end gap-2")],
        [
          html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants({ variant: "outline" })),
              html.Disabled(busy),
              html.OnClick(Message.Reset()),
            ],
            ["Cancelar"]
          ),
          html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants()),
              html.Disabled(busy),
              html.OnClick(Message.RequestedApproval()),
            ],
            [busy ? "Autorizando…" : "Autorizar acceso"]
          ),
        ]
      ),
    ]
  );
};
const invalidView = (model: PairingModel, html: Builder): Html =>
  html.section(
    [html.Class("flex flex-col gap-4")],
    [
      html.h2([], ["No encontramos ese código"]),
      html.p(
        [html.Role("alert")],
        [
          "La solicitud venció, no está disponible o necesitas iniciar sesión. Ejecuta fidy login para comenzar otra conexión si la solicitud venció.",
        ]
      ),
      Option.isSome(model.publicCode)
        ? html.a(
            [
              html.Class(buttonVariants()),
              html.Href(`/auth/pair?cliCode=${encodeURIComponent(model.publicCode.value)}`),
            ],
            ["Iniciar sesión para revisar la solicitud"]
          )
        : null,
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.OnClick(Message.Reset()),
        ],
        ["Ingresar otro código"]
      ),
    ]
  );
const enteringView = (
  model: PairingModel,
  html: Builder,
  input: Mount.MountAction<Message>
): Html => {
  const busy = model.status === "Inspecting";
  return html.section(
    [html.Class("flex flex-col gap-5")],
    [
      html.h2([html.Class("text-xl font-semibold")], ["Autorizar acceso con código"]),
      html.p([], ["Ingresa el código que aparece donde quieres usar Fidy."]),
      html.form(
        [
          html.Key("cli-code"),
          html.Class("flex flex-col gap-4"),
          html.OnSubmit(Message.RequestedInspection()),
        ],
        [
          html.label([html.For("pat-pairing-code")], ["Código"]),
          html.input([
            html.Id("pat-pairing-code"),
            html.Autocomplete("off"),
            html.Placeholder("BCDF-GHJK"),
            html.Disabled(busy),
            html.Class("rounded-md border p-2"),
            html.OnMount(input),
          ]),
          html.button(
            [
              html.Type("submit"),
              html.Class(buttonVariants()),
              html.Disabled(busy || !model.hasDraft),
            ],
            [busy ? "Buscando…" : "Continuar"]
          ),
        ]
      ),
    ]
  );
};
export const pairingView = (
  configuration: Readonly<{ model: PairingModel; html: Builder; input: Mount.MountAction<Message> }>
): Html => {
  const { model, html, input } = configuration;
  let content: Html;
  if (model.status === "Invalid") content = invalidView(model, html);
  else if (model.status === "Approved") {
    content = html.section(
      [],
      [
        html.h2([], ["Acceso autorizado"]),
        html.p(
          [],
          [
            "Puedes cerrar esta pestaña y volver a la terminal para completar la conexión. Este navegador no recibe ni muestra la clave de acceso.",
          ]
        ),
      ]
    );
  } else if (Option.isSome(model.review)) content = reviewView(model, html);
  else content = enteringView(model, html, input);
  return html.main(
    [html.Class("signed-in-theme flex min-h-svh justify-center bg-background px-5 py-10")],
    [
      html.section(
        [html.Class("flex w-full max-w-xl flex-col gap-6")],
        [
          html.a([html.Href("/")], ["Fidy"]),
          html.h1([html.Class("text-2xl font-semibold")], ["Conectar la CLI"]),
          html.p([], ["Autoriza únicamente una conexión que hayas iniciado con fidy login."]),
          content,
        ]
      ),
    ]
  );
};
