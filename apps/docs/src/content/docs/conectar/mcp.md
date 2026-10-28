---
title: Conectar mi agente con MCP
description: Aprueba una conexión de tu propio agente desde Fidy.
---

MCP permite que tu agente descubra y use herramientas de Fidy con los permisos que tú apruebas.

## Antes de empezar

Necesitas una cuenta Fidy con acceso a la aplicación, la autorización de tratamiento vigente y un cliente con MCP remoto por HTTP y OAuth. Para cambios sensibles, el cliente también necesita interacción nativa compatible. Empieza con las guías de [Claude Code](/conectar/claude-code) o [Codex](/conectar/codex).

## Conecta

1. Agrega `https://api.fidyapp.com/mcp` como servidor remoto en tu cliente.
2. Inicia la autenticación desde el cliente. Para consultar, solicita `read`; para registrar y corregir, solicita también `write`.
3. Cuando se abra el navegador, verifica el dominio `app.fidyapp.com` e inicia sesión con tu cuenta Fidy.
4. Revisa el nombre declarado por el cliente, los permisos y el vencimiento. El nombre no certifica la identidad del programa.
5. Selecciona **Conectar** y vuelve al cliente. Cancelar no concede acceso.
6. Pide: «Consulta mis transacciones en COP». Comprueba que la respuesta provenga de las herramientas de Fidy.

El servidor publica herramientas según los permisos efectivos. Esta documentación no sustituye esa autorización. No necesitas crear un PAT ni copiar contraseñas, tokens o códigos al chat.

## Continúa

- [Registrar y corregir transacciones](/transacciones/registrar-corregir).
- [Consultar mis finanzas](/consultar/finanzas).
- [Cambiar permisos o desconectar](/acceso/permisos).

La [CLI](/conectar/cli) es la alternativa para agentes que usan comandos de terminal. La configuración genérica de MCP no implica que todos los clientes soporten las confirmaciones requeridas.
