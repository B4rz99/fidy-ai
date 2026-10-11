import { DateTime, Option } from "effect";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { type ActivePATMetadata, patScopeCopy } from "@/transport/client";
import { buttonVariants } from "@/ui/button-variants";
import {
  ManagementMessage as Message,
  type ManagementModel as Model,
  type Selection,
} from "./management-model";
import { formatPATDate } from "./presentation";

type Builder = HtmlBuilder<Message>;
const unavailable = (model: Model): boolean => model.status !== "Ready" || model.uncertain;
const time = (value: DateTime.Utc, html: Builder): Html =>
  html.time([html.Datetime(DateTime.formatIso(value))], [formatPATDate(value)]);
const action = (model: Model, selection: Selection, html: Builder): Html =>
  html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: "outline" })),
      html.Disabled(unavailable(model)),
      html.OnClick(Message.Select({ selection })),
    ],
    [selection === "all" ? "Desactivar todos los tokens" : "Desactivar"]
  );
const row = (pat: ActivePATMetadata, model: Model, html: Builder): Html =>
  html.tr(
    [html.Key(pat.shortId), html.Class("border-b")],
    [
      html.th(
        [html.Attribute("scope", "row"), html.Class("px-2 py-3 text-left")],
        [
          html.span([html.Class("block font-semibold")], [pat.recipientLabel]),
          html.code([], [pat.shortId]),
        ]
      ),
      html.td(
        [html.Class("px-2 py-3")],
        pat.scopes.map((scope) =>
          html.span(
            [
              html.Class(
                "mr-1 inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
              ),
            ],
            [patScopeCopy[scope].label]
          )
        )
      ),
      html.td([html.Class("whitespace-nowrap px-2 py-3")], [time(pat.createdAt, html)]),
      html.td(
        [html.Class("whitespace-nowrap px-2 py-3")],
        [
          Option.match(pat.lastUsedAt, {
            onNone: () => "Nunca",
            onSome: (value) => time(value, html),
          }),
        ]
      ),
      html.td([html.Class("whitespace-nowrap px-2 py-3")], [time(pat.expiresAt, html)]),
      html.td([html.Class("px-2 py-3")], [action(model, pat.shortId, html)]),
    ]
  );
const confirmation = (model: Model, html: Builder): Html => {
  if (Option.isNone(model.selection)) return html.div([]);
  const all = model.selection.value === "all";
  const label = Option.flatMap(model.result, (result) =>
    Option.fromUndefinedOr(result.pats.find((pat) => Option.contains(model.selection, pat.shortId)))
  );
  const busy = model.status === "Revoking";
  return html.div(
    [html.Class("flex flex-col gap-3 rounded-lg border border-destructive/40 p-4")],
    [
      html.p(
        [],
        [
          all
            ? "¿Quieres desactivar todos tus tokens? También se cancelarán los tokens pendientes de activación."
            : `¿Quieres desactivar el token ${Option.match(label, { onNone: () => "seleccionado", onSome: (pat) => pat.recipientLabel })}? Dejará de funcionar de inmediato.`,
        ]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "destructive" })),
          html.Disabled(unavailable(model)),
          html.OnClick(Message.Confirm()),
        ],
        [confirmLabel(all, busy)]
      ),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(busy),
          html.OnClick(Message.Cancel()),
        ],
        ["Cancelar"]
      ),
    ]
  );
};
const confirmLabel = (all: boolean, busy: boolean): string => {
  if (busy) return all ? "Desactivando todos…" : "Desactivando…";
  return all ? "Sí, desactivar todos" : "Sí, desactivar";
};
const listing = (model: Model, html: Builder): Html => {
  if (Option.isNone(model.result)) {
    return html.p(
      [html.Role("status")],
      [model.status === "Loading" ? "Cargando tokens activos…" : "No pudimos cargar tus tokens"]
    );
  }
  const { pats } = model.result.value;
  if (pats.length === 0) {
    return html.div(
      [],
      [
        html.h3([], ["No tienes tokens activos."]),
        html.p([], ["Crea un token para darle acceso a tu agente."]),
      ]
    );
  }
  return html.div(
    [html.Class("overflow-x-auto")],
    [
      html.table(
        [html.AriaLabelledBy("active-pats-title"), html.Class("min-w-[42rem] w-full text-sm")],
        [
          html.thead(
            [],
            [
              html.tr(
                [],
                ["Nombre", "Permisos", "Creado el", "Último uso", "Vence el", "Acciones"].map(
                  (label) =>
                    html.th(
                      [html.Attribute("scope", "col"), html.Class("border-b px-2 py-3 text-left")],
                      [label]
                    )
                )
              ),
            ]
          ),
          html.tbody(
            [],
            pats.map((pat) => row(pat, model, html))
          ),
        ]
      ),
    ]
  );
};
export const managementListing = ({
  model,
  html,
}: Readonly<{ model: Model; html: Builder }>): Html =>
  html.section(
    [html.AriaLabelledBy("active-pats-title"), html.Class("flex flex-col gap-5")],
    [
      html.h2(
        [html.Id("active-pats-title"), html.Class("text-xl font-semibold")],
        ["Tokens activos"]
      ),
      model.notice.length > 0 ? html.p([html.Role("status")], [model.notice]) : null,
      model.status === "Failed" && Option.isSome(model.result)
        ? html.p(
            [html.Role("alert")],
            ["No pudimos actualizar tus tokens. Mostramos los últimos tokens disponibles."]
          )
        : null,
      listing(model, html),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(model.status === "Loading" || model.status === "Revoking"),
          html.OnClick(Message.Refresh()),
        ],
        ["Actualizar tokens"]
      ),
      action(model, "all", html),
      confirmation(model, html),
    ]
  );
export const managementView = (
  configuration: Readonly<{ model: Model; html: Builder; manual: Mount.MountAction<Message> }>
): Html => {
  const { model, html, manual } = configuration;
  return html.main(
    [html.Class("min-w-0")],
    [
      html.header(
        [html.Class("border-b p-6")],
        [
          html.h1([html.Class("text-2xl font-semibold")], ["Tokens de acceso"]),
          html.p([], ["Administra el acceso de tus agentes a Fidy."]),
        ]
      ),
      html.div(
        [html.Class("grid min-w-0 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_24rem]")],
        [
          managementListing({ model, html }),
          html.aside(
            [html.Class("min-w-0 border-t p-5 xl:border-t-0 xl:border-l")],
            [html.div([html.Key("manual-pat-program"), html.OnMount(manual)])]
          ),
        ]
      ),
    ]
  );
};
