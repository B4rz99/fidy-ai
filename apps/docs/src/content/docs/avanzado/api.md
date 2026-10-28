---
title: API avanzada
description: Usa el contrato HTTP de Fidy con un PAT limitado.
---

Para la mayoría de agentes, empieza con [MCP](/conectar/mcp) o la [CLI](/conectar/cli). La API directa requiere gestionar un PAT fuera del contexto del modelo.

## Autoriza

Crea un PAT con los permisos mínimos y vencimiento apropiado en [Configuración → Tokens personales](https://app.fidyapp.com/settings/access). Guárdalo en un gestor de secretos y haz que el ejecutor HTTP lo use en el encabezado `Authorization: Bearer`. No lo incluyas en URLs, argumentos de terminal, capturas ni chats.

La base es `https://api.fidyapp.com`. Un ejemplo de consulta es:

```http
GET /transactions?currency=COP
Host: api.fidyapp.com
Authorization: Bearer <PAT incorporado por tu ejecutor seguro>
```

El marcador no es una credencial. La documentación no solicita ni almacena tu PAT.

## Contrato público

Consulta el [OpenAPI para agentes](/reference/openapi.json) y la [referencia por operación](/reference). La URL `/openapi.json` del API no es un punto de descubrimiento público.

El contrato HTTP distingue parámetros de ruta, parámetros de consulta y cuerpo JSON. MCP y CLI presentan sus propios envoltorios: no copies un cuerpo HTTP como si fuera automáticamente la entrada completa de esas interfaces. Descubre los argumentos MCP en tu cliente y usa `--help` en la CLI.

Los esquemas incluyen restricciones, respuestas de éxito y errores declarados. Los códigos y nombres exactos del contrato se conservan aunque la guía esté en español.

## Ejecutor de agente

Mantén las credenciales dentro del ejecutor y entrega al modelo únicamente los datos que necesita para la tarea autorizada. Los permisos y decisiones de acceso se verifican en el servidor; las instrucciones de una página no los reemplazan.

Ante una respuesta incierta de una modificación, inspecciona el estado. No sigas redirecciones que puedan reenviar credenciales ni repitas cambios automáticamente. Revoca el PAT en Fidy cuando deje de ser necesario.
