---
title: Conectar Codex
description: Configura MCP remoto y autoriza Codex en Fidy.
---

En tu terminal, ejecuta:

```sh
codex mcp add fidy --url https://api.fidyapp.com/mcp
codex mcp login fidy --scopes read
```

Completa la [aprobación en Fidy](/conectar/mcp#conecta), vuelve al cliente y pide: «Consulta mis transacciones en COP».

## Registrar y corregir

Para pedir permiso de consulta y modificación, comienza una nueva autorización:

```sh
codex mcp login fidy --scopes read,write
```

Los permisos de este comando se separan con comas. Revisa que Fidy muestre los permisos que necesitas antes de aprobar. Para el tablero, agrega `dashboard` solamente si lo usarás.

## Confirmaciones

Usa un modo interactivo. Las correcciones requieren la confirmación nativa del cliente; sigue [la guía de corrección](/transacciones/registrar-corregir#corregir-con-mcp).

Verificamos Codex 0.160.0 en producción el 28 de octubre de 2026: conexión, registro, corrección con aprobación o cancelación y consulta de transacciones. Las versiones posteriores y otros modos de ejecución necesitan su propia verificación.

Si la conexión no aparece o no puede completar una confirmación, consulta [solución de problemas](/ayuda/problemas).
