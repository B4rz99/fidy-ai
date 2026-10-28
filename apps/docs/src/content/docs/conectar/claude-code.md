---
title: Conectar Claude Code
description: Configura MCP remoto y autoriza Claude Code en Fidy.
---

En una terminal del proyecto donde usarás Claude Code, ejecuta:

```sh
claude mcp add-json fidy '{"type":"http","url":"https://api.fidyapp.com/mcp","oauth":{"scopes":"read"}}'
```

Abre Claude Code, ejecuta `/mcp`, selecciona Fidy y elige autenticar. Completa la [aprobación en Fidy](/conectar/mcp#conecta). Luego pide: «Consulta mis transacciones en COP».

## Registrar y corregir

Para crear y corregir transacciones, configura `oauth.scopes` como `read write` y comienza una nueva autorización. Es una cadena con permisos separados por espacios. Si ya existe una configuración llamada `fidy`, actualízala con los controles de MCP de tu cliente antes de volver a autenticar.

Conserva `dashboard` únicamente si necesitas ver o editar el tablero. Revisa siempre los permisos en la pantalla de Fidy.

## Confirmaciones

Usa un modo interactivo. Las correcciones requieren la confirmación nativa del cliente; sigue [la guía de corrección](/transacciones/registrar-corregir#corregir-con-mcp).

Claude Code 2.1.289 tiene evidencia local de interacción nativa compatible. Una versión posterior o una prueba local no certifican por sí solas el recorrido completo en producción. Si la interacción falla, consulta [solución de problemas](/ayuda/problemas).

Consulta también la [documentación de MCP de Claude Code](https://code.claude.com/docs/en/mcp).
