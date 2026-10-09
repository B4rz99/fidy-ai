/** Explains setup, least-privilege access and independent revocation controls. */
export const AgentConnectionGuide = (): React.JSX.Element => (
  <section className="section wrap connection-guide" id="conectar" aria-labelledby="guia-agentes">
    <div className="section-head">
      <h2 id="guia-agentes">Conecta con contexto.</h2>
      <p>Elige una vía, revisa su disponibilidad y concede solo el acceso que necesitas.</p>
    </div>
    <div className="connection-notice">
      <strong>MCP remoto · conecta sin copiar tokens.</strong>
      <p>
        Conecta tu cliente con Fidy y aprueba su acceso en el navegador. No necesitas crear un token
        personal ni pegar credenciales en el chat para usar MCP.
      </p>
    </div>
    <p>
      <a className="textlink" href="/agentes.txt">
        Leer la guía en texto, sin JavaScript ↗
      </a>
    </p>
    {mcpSetup}
    {cliSetup}
    {apiSetup}
    {permissions}
  </section>
);

const mcpSetup = (
  <details open>
    <summary>MCP · Claude Code y Codex</summary>
    <p>
      Servidor: <code>https://api.fidyapp.com/mcp</code> (HTTP). Las versiones verificadas en
      pruebas locales son Claude Code 2.1.289 y Codex 0.160.0; otras versiones y clientes requieren
      verificación.
    </p>
    <h3>Claude Code · solo lectura</h3>
    <pre>
      <code>{`claude mcp add-json fidy '{"type":"http","url":"https://api.fidyapp.com/mcp","oauth":{"scopes":"read"}}'`}</code>
    </pre>
    <p>
      Abre <code>/mcp</code> en Claude Code y elige autenticar Fidy.
    </p>
    <h3>Codex · solo lectura</h3>
    <pre>
      <code>{`codex mcp add fidy --url https://api.fidyapp.com/mcp\ncodex mcp login fidy --scopes read`}</code>
    </pre>
    <p>
      Inicia sesión en <code>app.fidyapp.com</code>, revisa el destinatario, selecciona los permisos
      y una duración de 7, 30, 90 o 365 días. El nombre del cliente no certifica su identidad.
      Cancelar no concede acceso.
    </p>
  </details>
);

const cliSetup = (
  <details>
    <summary>CLI · para quienes tienen acceso al repositorio</summary>
    <p>
      La CLI se ejecuta desde el repositorio de Fidy con su versión fijada de Bun. No hay un paquete
      público de instalación documentado: estos comandos requieren una copia del proyecto y sus
      dependencias instaladas.
    </p>
    <pre>
      <code>{`bash scripts/install-bun.sh\n# Agrega a PATH el directorio que muestra el instalador.\nbash scripts/install-workspace.sh\nbun run cli login --recipient 'Mi agente' --scopes read --lifetime 7\nbun run cli status --json\nbun run cli commands --json\nbun run cli transactions listTransactions --help`}</code>
    </pre>
    <p>
      Aprueba la vinculación en Fidy. La CLI guarda su acceso en el almacén de credenciales del
      sistema, no en archivos de texto. Nunca pegues tokens en el chat. Consulta la lista de
      operaciones y su ayuda antes de usarlas.
    </p>
  </details>
);

const apiSetup = (
  <details>
    <summary>API · un token personal con permisos limitados</summary>
    <p>
      La API usa <code>https://api.fidyapp.com</code>. Crea un token personal (PAT) desde{" "}
      <a className="textlink" href="/settings/pats">
        Tokens personales
      </a>
      , con permiso <code>read</code> y 7 días si solo necesitas consultar. Conserva el valor en un
      gestor de secretos; Fidy lo muestra una sola vez.
    </p>
    <p>
      Ejemplo de consulta: <code>GET /transactions?currency=COP</code>. Envía el token en el
      encabezado <code>Authorization: Bearer</code>, nunca en la URL. La consulta respeta los
      permisos, las condiciones del servicio y los límites de tu cuenta.
    </p>
    <p>
      La especificación OpenAPI no se publica en <code>/openapi.json</code>. Si tienes acceso al
      proyecto, usa el contrato generado del servidor o la ayuda de la CLI; para orientación,{" "}
      <a className="textlink" href="mailto:obarboza@fidyapp.com">
        contacta a Fidy
      </a>
      .
    </p>
  </details>
);

const permissions = (
  <div className="steps connection-permissions">
    <article className="step">
      <h3>Empieza por lectura.</h3>
      <p>
        <code>read</code> permite consultar; <code>write</code>, crear y modificar;{" "}
        <code>dashboard</code>, trabajar con tu tablero. Para más permisos, revisa una nueva
        autorización.
      </p>
    </article>
    <article className="step">
      <h3>Revisa los cambios.</h3>
      <p>
        En MCP, las acciones sensibles requieren confirmación nativa en un cliente compatible. Un sí
        en el chat no la reemplaza. Fidy confía en la respuesta del cliente autorizado; no certifica
        la presencia de una persona.
      </p>
    </article>
    <article className="step">
      <h3>Desconecta cuando quieras.</h3>
      <p>
        Revoca MCP en{" "}
        <a className="textlink" href="/settings/agents">
          Agentes conectados
        </a>{" "}
        y los PAT en{" "}
        <a className="textlink" href="/settings/pats">
          Tokens personales
        </a>
        . Cerrar sesión no revoca esos accesos. Revocar detiene nuevas acciones, pero no deshace
        cambios completados.
      </p>
    </article>
  </div>
);
