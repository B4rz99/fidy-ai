# Conectar tu agente con Fidy

MCP remoto está disponible para conectar agentes con Fidy. El responsable del producto confirmó
su prueba en Producción el 9 de octubre de 2026. La evidencia automatizada y su alcance histórico
siguen documentados en el [informe de verificación](../research/hosted-mcp-release-990.md).
Esta actualización no amplía las versiones o clientes cubiertos por las pruebas automatizadas.

## Configuración

Usa `https://api.fidyapp.com/mcp` como servidor MCP remoto por HTTP. No necesitas instalar un
programa de Fidy, crear un token personal ni copiar credenciales al chat. Tu agente guarda sus
propias credenciales de conexión.

En Claude Code, agrega el servidor desde el proyecto donde lo usarás:

```sh
claude mcp add-json fidy \
  '{"type":"http","url":"https://api.fidyapp.com/mcp","oauth":{"scopes":"read write dashboard"}}'
```

Estos ejemplos solicitan los tres permisos; puedes quitar los que no necesites en Fidy.
Claude usa `oauth.scopes` como texto separado por espacios. Para pedir solo consulta, usa `read`.
Sin esta configuración, el desafío mínimo de Fidy pide solo consulta.

Abre `/mcp` y elige autenticar Fidy. En Codex CLI:

```sh
codex mcp add fidy --url https://api.fidyapp.com/mcp
codex mcp login fidy --scopes read,write,dashboard
```

Estos comandos configuran el cliente y comienzan su autorización en Fidy.
Las versiones con evidencia de confirmación nativa son Claude Code **2.1.289** y Codex **0.160.0**.
Estas versiones también completaron registro dinámico e inicio de sesión con la autoridad de
Fidy en una prueba local aislada; eso todavía no certifica el recorrido en Producción. Las versiones nuevas necesitan verificación. Pi, OpenCode, aplicaciones de escritorio y
MCP Apps no forman parte de esta verificación.

Cuando se abra el navegador, comprueba que estás en `app.fidyapp.com`, inicia sesión con tu cuenta
Fidy existente y revisa **Conectar con Fidy**. El nombre del agente lo declara el propio cliente;
Fidy no certifica su identidad a partir de ese nombre.

## Permisos y duración

La pantalla muestra únicamente los permisos que pidió el agente:

- **Consultar tus datos:** consultar la información disponible de tu cuenta.
- **Crear y modificar tus datos:** solicitar cambios en tus datos.
- **Ver y editar tu tablero:** consultar y modificar tu tablero.

Puedes quitar permisos; debes conservar al menos uno para conectar. No puedes agregar un permiso
que el agente no pidió. Si necesitas más permisos, comienza una nueva conexión y revisa la nueva
solicitud. Si el agente no pide permisos específicos, Fidy solicita únicamente consulta.

Elige **7, 30, 90 o 365 días**; la opción inicial es **90 días**. Revisa la fecha de vencimiento antes
de seleccionar **Conectar**. **Cancelar** no concede acceso. La renovación automática de las
credenciales funciona solamente dentro del periodo aprobado: no cambia la fecha de vencimiento.
Después del vencimiento debes aprobar una nueva conexión desde el navegador.

## Acciones y confirmación

Los cambios ordinarios usan los permisos aprobados sin pedir aprobación para cada cambio.
Una acción sensible muestra una solicitud nativa del agente con el efecto concreto y
**Confirmar la acción**. Revisa el efecto antes de aceptarla; cancelar, rechazar o dejar la casilla
sin confirmar no autoriza la acción. El permiso general del cliente para usar una herramienta es
una decisión distinta. Un «sí» en el chat no reemplaza esta confirmación.

Fidy confía en la respuesta de tu cliente autorizado. Un cliente modificado o una automatización
puede aceptar sin que una persona vea el formulario; esta respuesta no certifica presencia humana.
Si el cliente no puede completar la interacción, Fidy rechaza la acción sensible. No hay enlace
alternativo al navegador para esta confirmación.

## Desconectar

En Fidy, abre **Configuración → Agentes conectados** (`/settings/agents`). Cada aprobación aparece
como una conexión independiente, incluso si dos clientes tienen el mismo nombre. Revisa los
permisos, vencimiento y actividad reciente; puedes revocar una conexión o todas las conexiones.

Revocar impide nuevas acciones y renovaciones. No deshace cambios que ya se completaron.
**Cerrar sesión**, revocar **Tokens personales (PAT)** y revocar **Agentes conectados** son controles
separados: cerrar el navegador o revocar un PAT no desconecta los agentes OAuth.

## Resolver problemas

| Situación                                        | Qué hacer                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Solo aparecen consultas                          | Revisa los permisos aprobados. Para solicitar cambios, el cliente debe pedir el permiso correspondiente y debes aprobar una nueva conexión. |
| La conexión venció o fue revocada                | Inicia la conexión desde el agente y aprueba de nuevo en Fidy. La conexión anterior no se reactiva.                                         |
| El cliente no ofrece la confirmación nativa      | Usa una versión verificada y un modo interactivo. No intentes reemplazarla con texto en el chat.                                            |
| Se perdió la respuesta de un cambio              | Consulta el resultado antes de intentar otro cambio. No repitas automáticamente: el cambio pudo haberse completado.                         |
| Falló la renovación o se perdió su respuesta     | Inicia una nueva aprobación. La reutilización de una credencial de renovación puede revocar esa conexión.                                   |
| Fidy pide revisar tu autorización de tratamiento | Revisa y resuelve la solicitud en Fidy antes de continuar con operaciones ordinarias.                                                       |
| Hay un límite temporal                           | Respeta el tiempo indicado por el agente. Crear otra conexión no restablece los límites de tu cuenta.                                       |
| El inicio de sesión no termina                   | Cancela e inicia una nueva solicitud desde el agente. No copies códigos ni credenciales a chats o reportes de soporte.                      |

La configuración de clientes sigue sus [instrucciones oficiales de MCP](https://developers.openai.com/resources/docs-mcp)
y la [documentación de Claude Code](https://code.claude.com/docs/en/mcp). La evidencia de Fidy y sus
limitaciones están en el informe enlazado al comienzo.
