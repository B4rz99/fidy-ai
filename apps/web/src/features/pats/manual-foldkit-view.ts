import { DateTime, Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { patLifetimeDayOptions, patScopeCopy } from "@/transport/client";
import { buttonVariants } from "@/ui/components/button-variants";
import type { makeManualDisclosure } from "./manual-disclosure";
import {
  GrantDraft,
  ManualMessage as Message,
  type ManualModel as Model,
  type ReviewedGrant,
} from "./manual-model";

type Builder = HtmlBuilder<Message>;
const descriptions = {
  read: "Consultar tus datos financieros.",
  write: "Crear y modificar tus datos financieros.",
  dashboard: "Consultar y modificar tu tablero financiero.",
} as const;
const scopes = ["read", "write", "dashboard"] as const;
const format = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const scopeSelector = (model: Model, html: Builder): Html =>
  html.fieldset(
    [],
    [
      html.legend([html.Class("font-medium")], ["Permisos"]),
      ...scopes.map((scope) =>
        html.label(
          [
            html.Class("flex cursor-pointer items-start gap-3 border-b py-3"),
            html.For(`pat-scope-${scope}`),
          ],
          [
            html.input([
              html.Type("checkbox"),
              html.Id(`pat-scope-${scope}`),
              html.AriaLabel(`${patScopeCopy[scope].label}: ${descriptions[scope]}`),
              html.Checked(model.scopes.includes(scope)),
              html.OnClick(Message.ToggledScope({ scope })),
            ]),
            html.span(
              [],
              [
                html.span([html.Class("block font-medium")], [patScopeCopy[scope].label]),
                html.span([html.Class("text-sm text-muted-foreground")], [descriptions[scope]]),
              ]
            ),
          ]
        )
      ),
    ]
  );
const editor = (model: Model, html: Builder): Html =>
  html.form(
    [
      html.Key("manual-editor"),
      html.Class("flex flex-col gap-6"),
      html.OnSubmit(Message.RequestedReview()),
    ],
    [
      html.label([html.For("pat-recipient")], ["Nombre"]),
      html.input([
        html.Id("pat-recipient"),
        html.Autocomplete("off"),
        html.Class("rounded-md border p-2"),
        html.Placeholder("Ej. Mi agente personal"),
        html.Value(model.recipientLabel),
        html.OnInput((value) => Message.EditedLabel({ value })),
        html.AriaDescribedBy("pat-recipient-hint"),
      ]),
      html.p([html.Id("pat-recipient-hint")], ["Un nombre visible de 1 a 80 caracteres."]),
      scopeSelector(model, html),
      html.label([html.For("pat-lifetime")], ["Duración del token"]),
      html.select(
        [
          html.Id("pat-lifetime"),
          html.Value(String(model.lifetimeDays)),
          html.OnChange((value) => Message.ChoseDays({ value })),
        ],
        patLifetimeDayOptions.map((days) =>
          html.option([html.Value(String(days))], [`${days} días`])
        )
      ),
      html.button(
        [
          html.Type("submit"),
          html.Class(buttonVariants()),
          html.Disabled(
            !Schema.is(GrantDraft)({
              recipientLabel: model.recipientLabel.trim(),
              scopes: model.scopes,
              lifetimeDays: model.lifetimeDays,
            })
          ),
        ],
        ["Crear token"]
      ),
    ]
  );
const reviewView = (model: Model, html: Builder): Html => {
  if (Option.isNone(model.review)) {
    return html.output([], ["Preparando revisión…"]);
  }
  const busy = model.status === "Issuing";
  return html.section(
    [html.AriaLabel("Revisión del token"), html.Class("flex flex-col gap-5")],
    [
      html.h3([], ["Revisa el acceso"]),
      reviewDetails(model.review.value, html),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(busy),
          html.OnClick(Message.Edit()),
        ],
        ["Editar"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants()),
          html.Disabled(busy),
          html.OnClick(Message.RequestedIssue()),
        ],
        [busy ? "Creando token…" : "Confirmar y crear token"]
      ),
    ]
  );
};
const content = (
  model: Model,
  html: Builder,
  disclosure: ReturnType<typeof makeManualDisclosure>
): Html => {
  if (model.status === "Editing") return editor(model, html);
  if (model.status === "Reviewing" || model.status === "Issuing") return reviewView(model, html);
  if (model.status === "Failed") {
    return html.div(
      [html.Class("flex flex-col gap-4")],
      [
        html.h3([html.Role("alert")], ["No pudimos crear el token"]),
        html.p(
          [],
          ["Vuelve a emparejar el navegador si pasaron diez minutos y luego intenta de nuevo."]
        ),
        html.button(
          [html.Type("button"), html.Class(buttonVariants()), html.OnClick(Message.RetryReview())],
          ["Volver a la revisión"]
        ),
      ]
    );
  }
  return html.div(
    [html.Key("issued-pat"), html.Class("flex flex-col gap-5")],
    [
      html.h3([], ["Token creado"]),
      html.p(
        [],
        [
          "Guárdalo ahora en tu agente. Al salir de esta vista no podrás volver a consultar el token completo.",
        ]
      ),
      html.code([
        html.Key("pat-bearer"),
        html.Class("break-all rounded-lg border bg-muted p-4 text-sm"),
        html.OnMount(disclosure.reveal()),
      ]),
      html.button(
        [
          html.Key("copy-pat"),
          html.Type("button"),
          html.Class(buttonVariants()),
          html.OnMount(disclosure.copy()),
        ],
        [model.copied ? "Copiado" : "Copiar token"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.OnClick(Message.Reset()),
        ],
        ["Crear otro token"]
      ),
    ]
  );
};
export const manualView = (
  configuration: Readonly<{
    model: Model;
    html: Builder;
    disclosure: ReturnType<typeof makeManualDisclosure>;
  }>
): Html => {
  const { model, html, disclosure } = configuration;
  return html.section(
    [
      html.Id("create-pat"),
      html.AriaLabelledBy("create-pat-title"),
      html.Class("flex min-w-0 flex-col gap-6"),
    ],
    [
      html.h2([html.Id("create-pat-title"), html.Class("text-xl font-semibold")], ["Crear token"]),
      html.p([], ["Dale un nombre y elige solo los permisos que necesita tu agente."]),
      content(model, html, disclosure),
    ]
  );
};

const reviewDetails = ({ grant, reviewExpiresAt }: ReviewedGrant, html: Builder): Html =>
  html.dl(
    [html.Class("grid gap-2")],
    [
      html.dt([], ["Nombre"]),
      html.dd([], [grant.recipientLabel]),
      html.dt([], ["Permisos"]),
      html.dd(
        [],
        grant.scopes.map((scope) => html.span([html.Class("mr-2")], [patScopeCopy[scope].label]))
      ),
      html.dt([], ["Duración"]),
      html.dd([], [`${grant.lifetimeDays} días`]),
      html.dt([], ["Vencimiento estimado"]),
      html.dd(
        [],
        [
          html.time(
            [html.Datetime(DateTime.formatIso(reviewExpiresAt))],
            [format.format(DateTime.toDate(reviewExpiresAt))]
          ),
          html.p(
            [],
            [
              `El vencimiento exacto se calculará al crear el token, ${grant.lifetimeDays} días después.`,
            ]
          ),
        ]
      ),
    ]
  );
