import { DateTime, Duration, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { type OAuthReview, PATLifetimeDays, patLifetimeDayOptions } from "@/transport/client";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/button-variants";
import { Message, type Model, editable } from "./review-model";

const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const time = (value: DateTime.Utc, html: HtmlBuilder<Message>): Html =>
  html.time([html.Datetime(DateTime.formatIso(value))], [formatter.format(DateTime.toDate(value))]);
const permissions = (model: Model, review: OAuthReview, html: HtmlBuilder<Message>): Html =>
  html.fieldset(
    [html.Class("flex flex-col gap-3"), html.Disabled(!editable(model))],
    [
      html.legend([html.Class("mb-2 font-medium")], ["Permisos solicitados"]),
      ...review.permissions.map((permission) =>
        html.label(
          [
            html.Class("flex items-start gap-2"),
            html.For(`oauth-${permission.scope}`),
            html.Key(permission.scope),
          ],
          [
            html.input([
              html.Class("mt-1 size-4"),
              html.Id(`oauth-${permission.scope}`),
              html.Type("checkbox"),
              html.Checked(model.scopes.includes(permission.scope)),
              html.OnClick(Message.ToggledScope({ scope: permission.scope })),
            ]),
            html.span(
              [],
              [
                html.span([html.Class("block font-medium")], [permission.label]),
                html.span([html.Class("text-sm text-muted-foreground")], [permission.description]),
              ]
            ),
          ]
        )
      ),
    ]
  );
const durations = (model: Model, html: HtmlBuilder<Message>): Html =>
  html.fieldset(
    [html.Class("flex flex-wrap gap-2"), html.Disabled(!editable(model))],
    [
      html.legend([html.Class("mb-2 font-medium")], ["Duración"]),
      ...patLifetimeDayOptions.map((days) =>
        html.button(
          [
            html.Key(String(days)),
            html.Type("button"),
            html.AriaPressed(String(model.days === days)),
            html.Class(buttonVariants({ variant: model.days === days ? "default" : "outline" })),
            html.OnClick(Message.SelectedDays({ days: PATLifetimeDays.make(days) })),
          ],
          [`${days} días`]
        )
      ),
    ]
  );
const actions = (model: Model, html: HtmlBuilder<Message>): Html =>
  html.div(
    [html.Class("flex gap-2")],
    [
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants()),
          html.Disabled(!editable(model) || model.scopes.length === 0),
          html.OnClick(Message.ClickedConnect()),
        ],
        [model.status === "Connecting" || model.status === "Uncertain" ? "Conectando…" : "Conectar"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(!editable(model)),
          html.OnClick(Message.ClickedCancel()),
        ],
        [model.status === "Cancelling" ? "Cancelando…" : "Cancelar"]
      ),
    ]
  );
const reviewCard = (model: Model, review: OAuthReview, html: HtmlBuilder<Message>): Html =>
  card({
    html,
    className: "w-full max-w-md",
    title: "Conectar con Fidy",
    description: "Nombre declarado por el cliente; Fidy no verifica su identidad.",
    content: [
      html.p([html.Class("break-words font-semibold")], [review.claimedClientName]),
      permissions(model, review, html),
      model.scopes.length === 0
        ? html.p([html.Role("alert")], ["Selecciona al menos un permiso."])
        : null,
      durations(model, html),
      html.p(
        [html.Class("text-sm")],
        [
          "Vencimiento previsto: ",
          time(DateTime.addDuration(review.reviewedAt, Duration.days(model.days)), html),
        ]
      ),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        ["Esta solicitud vence: ", time(review.requestExpiresAt, html), "."]
      ),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        [
          "El acceso vence en la fecha indicada. Para renovarlo tendrás que aprobar una nueva conexión.",
        ]
      ),
    ].filter((item): item is Html => item !== null),
    footer: [actions(model, html)],
  });
const content = (
  model: Model,
  html: HtmlBuilder<Message>,
  requestId: Option.Option<string>
): Html => {
  if (Option.isNone(requestId)) return html.p([html.Role("alert")], ["La solicitud no es válida."]);
  if (model.status === "Cancelled") {
    return html.output([], ["Solicitud cancelada. No se autorizó ningún acceso."]);
  }
  if (model.status === "Loading") return html.output([], ["Cargando solicitud…"]);
  if (Option.isSome(model.review)) return reviewCard(model, model.review.value, html);
  return card({
    html,
    className: "max-w-md",
    title: "Solicitud no disponible",
    description:
      "Puede haber vencido o requerir un nuevo inicio de sesión. No se autorizó ningún acceso.",
    content: [
      html.a(
        [
          html.Href(`/auth/pair?oauthRequest=${encodeURIComponent(requestId.value)}`),
          html.Class(buttonVariants()),
        ],
        ["Iniciar sesión"]
      ),
    ],
    footer: [],
  });
};
/** Only reviewed permissions and public choices enter the presentation. */
export const reviewView = ({
  model,
  html,
  requestId,
}: Readonly<{
  model: Model;
  html: HtmlBuilder<Message>;
  requestId: Option.Option<string>;
}>): Html =>
  html.main(
    [
      html.Class(
        "flex min-h-svh flex-col items-center justify-center gap-3 bg-muted/40 px-4 py-12"
      ),
    ],
    [
      model.status === "Uncertain"
        ? html.p(
            [html.Role("alert")],
            [
              "No pudimos confirmar el resultado. Inicia una nueva conexión desde tu agente; no repitas esta aprobación.",
            ]
          )
        : null,
      model.status === "CancelFailed"
        ? html.p(
            [html.Role("alert")],
            ["No pudimos cancelar. Intenta de nuevo; no se autorizó ningún acceso."]
          )
        : null,
      content(model, html, requestId),
    ]
  );
