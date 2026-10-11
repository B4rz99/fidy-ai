import { DateTime, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionMetadata,
} from "@/transport/client";
import { buttonVariants } from "@/ui/button-variants";
import { Message, type Model } from "./management-model";

const dateFormat = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});
const timestamp = (value: DateTime.Utc, html: HtmlBuilder<Message>): Html =>
  html.time(
    [html.Datetime(DateTime.formatIso(value))],
    [dateFormat.format(DateTime.toDate(value)).replaceAll("/", "-")]
  );
const states = { active: "Activo", expired: "Vencido", revoked: "Revocado" } as const;
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
const connectionRow = (
  connection: OAuthConnectionMetadata,
  busy: boolean,
  html: HtmlBuilder<Message>
): Html =>
  html.tr(
    [
      html.Key(connection.connectionId),
      html.Attribute("data-connection-id", connection.connectionId),
      html.Class("border-b"),
    ],
    [
      html.th(
        [html.Attribute("scope", "row"), html.Class("px-2 py-3 text-left font-semibold")],
        [connection.claimedClientName]
      ),
      html.td([html.Class("px-2 py-3")], [states[connection.state]]),
      html.td(
        [html.Class("px-2 py-3")],
        connection.permissions.map((permission) =>
          html.span(
            [
              html.Key(permission.scope),
              html.Class(
                "mr-1 inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
              ),
            ],
            [permission.label]
          )
        )
      ),
      html.td([html.Class("whitespace-nowrap px-2 py-3")], [timestamp(connection.expiresAt, html)]),
      html.td(
        [html.Class("px-2 py-3")],
        [
          connection.state === "active"
            ? revokeButton("Revocar este agente", Option.some(connection.connectionId), {
                busy,
                html,
              })
            : html.p(
                [html.Class("text-sm")],
                ["Para volver a conectarlo necesitas una nueva aprobación."]
              ),
        ]
      ),
    ]
  );
const connectionTable = (
  list: OAuthConnectionList,
  busy: boolean,
  html: HtmlBuilder<Message>
): Html =>
  html.div(
    [html.Class("min-w-0 overflow-x-auto")],
    [
      html.table(
        [html.AriaLabel("Conexiones MCP"), html.Class("w-full min-w-[36rem] text-sm")],
        [
          html.thead(
            [],
            [
              html.tr(
                [html.Class("border-b")],
                ["Nombre", "Estado", "Permisos", "Vence el", "Acciones"].map((label) =>
                  html.th(
                    [html.Attribute("scope", "col"), html.Class("px-2 py-3 text-left")],
                    [label]
                  )
                )
              ),
            ]
          ),
          html.tbody(
            [],
            list.connections.map((connection) => connectionRow(connection, busy, html))
          ),
        ]
      ),
    ]
  );
const listingView = ({
  list,
  busy,
  html,
  basePath,
}: Readonly<{
  list: OAuthConnectionList;
  busy: boolean;
  html: HtmlBuilder<Message>;
  basePath: string;
}>): Html =>
  html.section(
    [html.Class("flex flex-col gap-4")],
    [
      ...(list.connections.length === 0
        ? [html.p([], ["No hay conexiones en esta página."])]
        : [connectionTable(list, busy, html)]),
      Option.match(list.nextCursor, {
        onNone: () => null,
        onSome: (id) =>
          busy
            ? html.span([html.AriaDisabled(true)], ["Siguiente página"])
            : html.a(
                [
                  html.Class(buttonVariants({ variant: "outline" })),
                  html.Href(`${basePath}?after=${encodeURIComponent(id)}`),
                ],
                ["Siguiente página"]
              ),
      }),
      revokeButton("Revocar todos los agentes conectados", Option.none(), { busy, html }),
    ]
  );
const content = (model: Model, html: HtmlBuilder<Message>, basePath: string): Html => {
  if (Option.isSome(model.list)) {
    return listingView({
      list: model.list.value,
      busy: model.status !== "Ready" || model.revocation === "Uncertain",
      html,
      basePath,
    });
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
const needsRefresh = (model: Model, presentation: "Standalone" | "Access"): boolean =>
  presentation === "Standalone" || model.status === "Failed" || model.revocation === "Uncertain";
const notices = (model: Model, html: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const result: Html[] = [];
  if (model.revocation === "Succeeded") {
    result.push(
      html.p([html.Role("status")], ["Acceso revocado. Las acciones ya realizadas se conservan."])
    );
  }
  if (model.revocation === "Uncertain") {
    result.push(
      html.p(
        [html.Role("alert")],
        ["No pudimos confirmar la revocación. Actualiza la lista antes de intentar de nuevo."]
      )
    );
  }
  if (model.status === "Failed" && Option.isSome(model.list)) {
    result.push(
      html.p(
        [html.Role("alert")],
        ["No pudimos actualizar la lista. La información anterior puede haber cambiado."]
      )
    );
  }
  return result;
};

/** Server-derived metadata remains text; revocation identifies the canonical connection. */
export const managementView = ({
  model,
  html,
  after,
  presentation,
}: Readonly<{
  model: Model;
  html: HtmlBuilder<Message>;
  after: Option.Option<OAuthConnectionId>;
  presentation: "Standalone" | "Access";
}>): Html =>
  html.section(
    [
      html.Class(
        presentation === "Access"
          ? "flex min-w-0 flex-col gap-5"
          : "mx-auto flex max-w-3xl flex-col gap-4 p-6"
      ),
    ],
    [
      html.h2([html.Class("font-heading text-xl font-semibold")], ["Conexiones MCP"]),
      ...notices(model, html),
      content(model, html, presentation === "Access" ? "/settings/access" : "/settings/agents"),
      needsRefresh(model, presentation)
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants({ variant: "outline" })),
              html.Disabled(model.status === "Revoking" || model.status === "Loading"),
              html.OnClick(Message.ClickedRefresh()),
            ],
            ["Actualizar lista"]
          )
        : null,
      Option.isSome(after)
        ? html.a(
            [
              html.Href(presentation === "Access" ? "/settings/access" : "/settings/agents"),
              html.Class(buttonVariants({ variant: "outline" })),
            ],
            ["Primera página"]
          )
        : null,
    ]
  );
