---
title: Permisos y acceso
description: Controla qué puede hacer cada agente y durante cuánto tiempo.
---

Cada conexión tiene permisos y vencimiento propios. Compartir una guía o descubrir una herramienta no concede acceso.

| Permiso     | Uso                                       |
| ----------- | ----------------------------------------- |
| `read`      | Consultar datos disponibles de tu cuenta. |
| `write`     | Crear y modificar datos.                  |
| `dashboard` | Consultar y editar el tablero.            |

Para empezar a consultar, solicita solo `read`. Para registrar y corregir, agrega `write`. Puedes quitar permisos de una solicitud, pero no agregar otros que el cliente no pidió. Para ampliarlos, comienza una nueva autorización.

## Vencimiento

La aprobación permite elegir 7, 30, 90 o 365 días. Comprueba la fecha exacta antes de conectar. La renovación de credenciales MCP no amplía el periodo que aprobaste. Una conexión vencida necesita una nueva autorización.

## Cambios sensibles

Los cambios ordinarios usan los permisos ya aprobados. Las acciones sensibles requieren la confirmación que corresponda al tipo de acceso. Con OAuth, las acciones sensibles, incluidas las correcciones de transacciones, requieren la interacción nativa del cliente con aceptación explícita del efecto concreto. No existe un paso adicional de aprobación de la operación en el navegador.

Revisa el efecto concreto. Cancelar o rechazar no autoriza el cambio. La aprobación general de herramientas en el cliente y un «sí» en el chat no sustituyen estas comprobaciones. La respuesta de un cliente autorizado no certifica por sí sola presencia humana.

## Revocar

- **MCP/OAuth:** abre [Configuración → Agentes conectados](https://app.fidyapp.com/settings/agents). Revoca la conexión correspondiente o todas las conexiones. Dos clientes con el mismo nombre pueden tener aprobaciones independientes.
- **CLI o API con PAT:** abre [Configuración → Tokens personales](https://app.fidyapp.com/settings/access) y revoca el PAT correspondiente.
- **CLI local:** `fidy logout` borra el acceso guardado en ese equipo; no revoca el PAT del servidor.

Cerrar sesión en el navegador no desconecta tus agentes. Revocar impide acciones posteriores y renovaciones, pero no deshace cambios completados.

## Límites y plan

Los permisos no eliminan los límites de cuenta ni los requisitos del plan. Distingue una espera temporal, una cuota agotada y una operación que requiere otro plan. Crear más conexiones no restablece la cuota de tu cuenta. Consulta los errores de la [referencia](/reference).
