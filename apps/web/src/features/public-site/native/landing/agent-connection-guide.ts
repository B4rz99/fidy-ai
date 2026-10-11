import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";
/** Explains setup, least-privilege access and independent revocation controls. */
export const AgentConnectionGuide = (configuration: ViewConfiguration): ViewContent => [
  connectionGuideViewPart(configuration),
];
const mcpSetup = (configuration: ViewConfiguration): ViewContent => [
  contentViewPartPart(configuration),
];
const cliSetup = (configuration: ViewConfiguration): ViewContent => [
  contentViewPartPartPart(configuration),
];
const apiSetup = (configuration: ViewConfiguration): ViewContent => [
  textlinkViewPart(configuration),
];
const permissions = (configuration: ViewConfiguration): ViewContent => [
  stepsViewPart(configuration),
];
const connectionGuideViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [
      html.Class("section wrap connection-guide"),
      html.Id("conectar"),
      html.Attribute("aria-labelledby", String("guia-agentes")),
    ],
    [
      html.div(
        [html.Class("section-head")],
        [
          html.h2([html.Id("guia-agentes")], ["Conecta con contexto."]),
          html.p(
            [],
            ["Elige una vía, revisa su disponibilidad y concede solo el acceso que necesitas."]
          ),
        ]
      ),
      html.div(
        [html.Class("connection-notice")],
        [
          html.strong([], ["MCP remoto · conecta sin copiar tokens."]),
          html.p(
            [],
            [
              "Conecta tu cliente con Fidy y aprueba su acceso en el navegador. No necesitas crear un token personal ni pegar credenciales en el chat para usar MCP.",
            ]
          ),
        ]
      ),
      html.p(
        [],
        [
          html.a(
            [html.Class("textlink"), html.Href("/llms.txt")],
            ["Leer la guía en texto, sin JavaScript ↗"]
          ),
        ]
      ),
      ...mcpSetup(configuration),
      ...cliSetup(configuration),
      ...apiSetup(configuration),
      ...permissions(configuration),
    ]
  );
};
const contentViewPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [html.Open(true)],
    [
      html.summary([], ["MCP · Claude Code y Codex"]),
      html.p([], ["Servidor: ", html.code([], ["https://api.fidyapp.com/mcp"]), " (HTTP)."]),
      html.h3([], ["Claude Code · solo lectura"]),
      html.pre(
        [],
        [
          html.code(
            [],
            [
              `claude mcp add-json fidy '{"type":"http","url":"https://api.fidyapp.com/mcp","oauth":{"scopes":"read"}}'`,
            ]
          ),
        ]
      ),
      html.p([], ["Abre ", html.code([], ["/mcp"]), " en Claude Code y elige autenticar Fidy."]),
      html.h3([], ["Codex · solo lectura"]),
      html.pre(
        [],
        [
          html.code(
            [],
            [
              `codex mcp add fidy --url https://api.fidyapp.com/mcp\ncodex mcp login fidy --scopes read`,
            ]
          ),
        ]
      ),
      html.p(
        [],
        [
          "Inicia sesión en ",
          html.code([], ["app.fidyapp.com"]),
          ", revisa el destinatario, selecciona los permisos y una duración de 7, 30, 90 o 365 días. El nombre del cliente no certifica su identidad. Cancelar no concede acceso.",
        ]
      ),
    ]
  );
};
const contentViewPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary([], ["CLI · para quienes tienen acceso al repositorio"]),
      html.p(
        [],
        [
          "La CLI se ejecuta desde el repositorio de Fidy con su versión fijada de Bun. No hay un paquete público de instalación documentado: estos comandos requieren una copia del proyecto y sus dependencias instaladas.",
        ]
      ),
      html.pre(
        [],
        [
          html.code(
            [],
            [
              `bash scripts/install-bun.sh\n# Agrega a PATH el directorio que muestra el instalador.\nbash scripts/install-workspace.sh\nbun run cli login --recipient 'Mi agente' --scopes read --lifetime 7\nbun run cli status --json\nbun run cli commands --json\nbun run cli transactions listTransactions --help`,
            ]
          ),
        ]
      ),
      html.p(
        [],
        [
          "Aprueba la vinculación en Fidy. La CLI guarda su acceso en el almacén de credenciales del sistema, no en archivos de texto. Nunca pegues tokens en el chat. Consulta la lista de operaciones y su ayuda antes de usarlas.",
        ]
      ),
    ]
  );
};
const textlinkViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.details(
    [],
    [
      html.summary([], ["API · un token personal con permisos limitados"]),
      html.p(
        [],
        [
          "La API usa ",
          html.code([], ["https://api.fidyapp.com"]),
          ". Crea un token personal (PAT) desde",
          " ",
          html.a([html.Class("textlink"), html.Href("/settings/pats")], ["Tokens personales"]),
          ", con permiso ",
          html.code([], ["read"]),
          " y 7 días si solo necesitas consultar. Conserva el valor en un gestor de secretos; Fidy lo muestra una sola vez.",
        ]
      ),
      html.p(
        [],
        [
          "Ejemplo de consulta: ",
          html.code([], ["GET /transactions?currency=COP"]),
          ". Envía el token en el encabezado ",
          html.code([], ["Authorization: Bearer"]),
          ", nunca en la URL. La consulta respeta los permisos, las condiciones del servicio y los límites de tu cuenta.",
        ]
      ),
      html.p(
        [],
        [
          "La especificación OpenAPI no se publica en ",
          html.code([], ["/openapi.json"]),
          ". Si tienes acceso al proyecto, usa el contrato generado del servidor o la ayuda de la CLI; para orientación,",
          " ",
          html.a(
            [html.Class("textlink"), html.Href("mailto:obarboza@fidyapp.com")],
            ["contacta a Fidy"]
          ),
          ".",
        ]
      ),
    ]
  );
};
const stepsViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("steps connection-permissions")],
    [
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["Empieza por lectura."]),
          html.p(
            [],
            [
              html.code([], ["read"]),
              " permite consultar; ",
              html.code([], ["write"]),
              ", crear y modificar;",
              " ",
              html.code([], ["dashboard"]),
              ", trabajar con tu tablero. Para más permisos, revisa una nueva autorización.",
            ]
          ),
        ]
      ),
      html.article(
        [html.Class("step")],
        [
          html.h3([], ["Revisa los cambios."]),
          html.p(
            [],
            [
              "En MCP, las acciones sensibles requieren confirmación nativa en un cliente compatible. Un sí en el chat no la reemplaza. Fidy confía en la respuesta del cliente autorizado; no certifica la presencia de una persona.",
            ]
          ),
        ]
      ),
      textlinkViewSection(configuration),
    ]
  );
};
const textlinkViewSection = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.article(
    [html.Class("step")],
    [
      html.h3([], ["Desconecta cuando quieras."]),
      html.p(
        [],
        [
          "Revoca MCP en",
          " ",
          html.a([html.Class("textlink"), html.Href("/settings/agents")], ["Agentes conectados"]),
          " ",
          "y los PAT en",
          " ",
          html.a([html.Class("textlink"), html.Href("/settings/pats")], ["Tokens personales"]),
          ". Cerrar sesión no revoca esos accesos. Revocar detiene nuevas acciones, pero no deshace cambios completados.",
        ]
      ),
    ]
  );
};
