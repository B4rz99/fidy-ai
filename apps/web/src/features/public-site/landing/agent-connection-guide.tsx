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
      <a className="textlink" href="/llms.txt">
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
      Servidor: <code>https://api.fidyapp.com/mcp</code> (HTTP).
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
    <summary>CLI · instala y conecta</summary>
    <p>Instala Fidy y conecta tu agente con acceso de solo lectura por 7 días.</p>
    <h3>macOS Apple Silicon o Linux x64 con glibc</h3>
    <pre>
      <code>curl -fsSL https://fidyapp.com/install.sh | bash</code>
    </pre>
    <p>
      En Linux necesitas AVX2 y un almacén de credenciales activo, como GNOME Keyring o KWallet.
    </p>
    <h3>Windows x64 · PowerShell</h3>
    <pre>
      <code>
        {
          "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://fidyapp.com/install.ps1).Content))"
        }
      </code>
    </pre>
    <p>Abre una terminal nueva y conecta tu agente:</p>
    <pre>
      <code>{"fidy login --recipient 'Mi agente' --scopes read --lifetime 7"}</code>
    </pre>
    <p>Aprueba el acceso en Fidy.</p>
    <details>
      <summary>Requisitos y ayuda</summary>
      <p>
        No necesitas clonar el repositorio ni instalar Bun o Node. Repite el instalador para
        actualizar.
      </p>
      <p>
        La CLI guarda su acceso en el almacén de credenciales del sistema, no en archivos de texto.
        Nunca pegues tokens en el chat. Consulta la lista de operaciones y su ayuda antes de
        usarlas.
      </p>
      <pre>
        <code>
          {"fidy status --json\nfidy commands --json\nfidy transactions listTransactions --help"}
        </code>
      </pre>
    </details>
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
      <h3>Empieza con solo lectura.</h3>
      <p>Concede permisos de escritura solo si los necesitas.</p>
      <details>
        <summary>Ver permisos</summary>
        <p>
          <code>read</code> permite consultar; <code>write</code>, crear y modificar;{" "}
          <code>dashboard</code>, trabajar con tu tablero. Para más permisos, revisa una nueva
          autorización.
        </p>
      </details>
    </article>
    <article className="step">
      <h3>Revisa los cambios.</h3>
      <p>Las acciones sensibles requieren confirmación en clientes MCP compatibles.</p>
      <details>
        <summary>Sobre la confirmación</summary>
        <p>
          En MCP, las acciones sensibles requieren confirmación nativa en un cliente compatible. Un
          sí en el chat no la reemplaza. Fidy confía en la respuesta del cliente autorizado; no
          certifica la presencia de una persona.
        </p>
      </details>
    </article>
    <article className="step">
      <h3>Desconecta cuando quieras.</h3>
      <p>
        Gestiona el acceso en{" "}
        <a className="textlink" href="/settings/agents">
          Agentes conectados
        </a>{" "}
        o{" "}
        <a className="textlink" href="/settings/pats">
          Tokens personales
        </a>
        . Cerrar sesión no revoca accesos.
      </p>
      <details>
        <summary>Qué implica revocar</summary>
        <p>Revocar detiene nuevas acciones, pero no deshace cambios completados.</p>
      </details>
    </article>
  </div>
);
