import { DateTime, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionMetadata,
} from "@/transport/client";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/button-variants";
import { Message, type Model } from "./management-model";

const dateFormat = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const timestamp = (value: DateTime.Utc, html: HtmlBuilder<Message>): Html =>
  html.time(
    [html.Datetime(DateTime.formatIso(value))],
    [dateFormat.format(DateTime.toDate(value))]
  );
const states = { active: "Activo", expired: "Vencido", revoked: "Revocado" } as const;
const outcomes = { succeeded: "Completada", rejected: "Rechazada", failed: "Fallida" } as const;
const revokeButton = (
  label: string,
  id: Option.Option<OAuthConnectionId>,
  { busy, html }: Readonly<{ busy: boolean; html: HtmlBuilder<Message> }>
): Html =>
  html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: "destructive" })),
      html.Disabled(busy),
      html.OnClick(Message.ClickedRevoke({ id })),
    ],
    [label]
  );
const activityView = (connection: OAuthConnectionMetadata, html: HtmlBuilder<Message>): Html => {
  if (connection.recentActivity.length === 0) {
    return html.p(
      [html.Class("text-sm text-muted-foreground")],
      ["Sin llamadas registradas en la evidencia conservada."]
    );
  }
  return html.ul(
    [html.Class("text-sm")],
    connection.recentActivity.map((activity) =>
      html.li(
        [html.Key(activity.id)],
        [
          html.code([], [activity.operation]),
          ` — ${outcomes[activity.outcome]} — `,
          timestamp(activity.occurredAt, html),
        ]
      )
    )
  );
};
const connectionCard = (
  connection: OAuthConnectionMetadata,
  busy: boolean,
  html: HtmlBuilder<Message>
): Html =>
  card({
    html,
    className: "",
    title: connection.claimedClientName,
    description: "Nombre declarado; Fidy no verifica la identidad del cliente.",
    content: [
      html.p(
        [html.Class("break-all text-xs text-muted-foreground")],
        [`Conexión: ${connection.connectionId}`]
      ),
      html.p([], [`Estado: ${states[connection.state]}`]),
      html.ul(
        [],
        connection.permissions.map((permission) =>
          html.li([html.Key(permission.scope)], [permission.label])
        )
      ),
      html.p([], ["Vence: ", timestamp(connection.expiresAt, html)]),
      html.h3([html.Class("font-medium")], ["Actividad reciente"]),
      activityView(connection, html),
    ],
    footer: [
      connection.state === "active"
        ? revokeButton("Revocar este agente", Option.some(connection.connectionId), { busy, html })
        : html.p(
            [html.Class("text-sm")],
            ["Para volver a conectarlo necesitas una nueva aprobación."]
          ),
    ],
  });
const listingView = (list: OAuthConnectionList, busy: boolean, html: HtmlBuilder<Message>): Html =>
  html.section(
    [html.Class("flex flex-col gap-4")],
    [
      html.p(
        [],
        [
          "Revocar detiene llamadas y renovaciones futuras; no deshace acciones ya realizadas. El acceso vencido o revocado requiere una nueva aprobación.",
        ]
      ),
      html.p(
        [],
        [
          "Cerrar sesión y revocar tokens personales (PAT) son controles separados: no revocan estos agentes. Revocar agentes no cambia tus tokens personales ni la sesión del agente de Fidy.",
        ]
      ),
      revokeButton("Revocar todos los agentes conectados", Option.none(), { busy, html }),
      ...(list.connections.length === 0
        ? [html.p([], ["No hay conexiones en esta página."])]
        : list.connections.map((connection) => connectionCard(connection, busy, html))),
      Option.match(list.nextCursor, {
        onNone: () => null,
        onSome: (id) =>
          busy
            ? html.span([html.AriaDisabled(true)], ["Siguiente página"])
            : html.a(
                [
                  html.Class(buttonVariants({ variant: "outline" })),
                  html.Href(`/settings/agents?after=${encodeURIComponent(id)}`),
                ],
                ["Siguiente página"]
              ),
      }),
    ]
  );
const content = (model: Model, html: HtmlBuilder<Message>): Html => {
  if (Option.isSome(model.list)) {
    return listingView(
      model.list.value,
      model.status !== "Ready" || model.revocation === "Uncertain",
      html
    );
  }
  if (model.status === "Loading") return html.output([], ["Cargando agentes…"]);
  return html.section(
    [],
    [
      html.p(
        [html.Role("alert")],
        [
          "No pudimos consultar los agentes. Puede que necesites iniciar sesión de nuevo; no mostramos una lista vacía ni confirmamos revocaciones.",
        ]
      ),
      html.a(
        [html.Href("/auth/pair"), html.Class(buttonVariants({ variant: "outline" }))],
        ["Iniciar sesión de nuevo"]
      ),
    ]
  );
};
/** Server-derived metadata remains text; revocation identifies the canonical connection. */
export const managementView = ({
  model,
  html,
  after,
}: Readonly<{
  model: Model;
  html: HtmlBuilder<Message>;
  after: Option.Option<OAuthConnectionId>;
}>): Html =>
  html.main(
    [html.Class("mx-auto flex max-w-3xl flex-col gap-4 p-6")],
    [
      html.h1([html.Class("font-heading text-2xl font-semibold")], ["Agentes conectados"]),
      model.revocation === "Succeeded"
        ? html.p(
            [html.Role("status")],
            ["Acceso revocado. Las acciones ya realizadas se conservan."]
          )
        : null,
      model.revocation === "Uncertain"
        ? html.p(
            [html.Role("alert")],
            ["No pudimos confirmar la revocación. Actualiza la lista antes de intentar de nuevo."]
          )
        : null,
      model.status === "Failed" && Option.isSome(model.list)
        ? html.p(
            [html.Role("alert")],
            ["No pudimos actualizar la lista. La información anterior puede haber cambiado."]
          )
        : null,
      content(model, html),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(model.status === "Revoking" || model.status === "Loading"),
          html.OnClick(Message.ClickedRefresh()),
        ],
        ["Actualizar lista"]
      ),
      Option.isSome(after)
        ? html.a(
            [html.Href("/settings/agents"), html.Class(buttonVariants({ variant: "outline" }))],
            ["Primera página"]
          )
        : null,
    ]
  );
