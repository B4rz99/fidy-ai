---
title: Solución de problemas
description: Resuelve conexiones, permisos, confirmaciones y resultados inciertos.
---

| Situación                                               | Qué hacer                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No aparecen herramientas de modificación                | Revisa los permisos. Solicita `write` y aprueba una nueva conexión; cambiar el prompt no amplía el acceso.                                              |
| Venció o se revocó la conexión                          | Inicia otra autorización desde el cliente. La conexión anterior no se reactiva.                                                                         |
| No se completa una corrección por MCP                   | Usa un cliente interactivo compatible y completa la confirmación nativa requerida dentro del cliente.                                                   |
| La revisión de una transacción cambió                   | Consulta el registro actual y decide nuevamente qué corregir; no reutilices una revisión obsoleta.                                                      |
| Se perdió la respuesta de un cambio                     | Consulta primero el estado. El cambio pudo completarse; no lo repitas automáticamente.                                                                  |
| Fidy pide revisar la autorización de tratamiento        | Resuelve la solicitud dentro de Fidy antes de continuar con operaciones ordinarias.                                                                     |
| Hay un límite temporal                                  | Respeta el tiempo indicado por el servicio. Una cuota agotada o un requisito de plan no se resuelven esperando unos segundos.                           |
| Falló una renovación MCP                                | Comienza una nueva aprobación. Reutilizar credenciales de renovación puede revocar esa conexión.                                                        |
| La CLI no puede guardar el acceso                       | Revisa el almacén de credenciales del sistema; en Linux necesita un Secret Service desbloqueado. No lo sustituyas por un archivo de texto con el token. |
| La CLI dice que hay acceso, pero el servidor lo rechaza | `status` es local. Revisa vencimiento, revocación, permisos y autorización de tratamiento.                                                              |
| La consulta no devuelve lo esperado                     | Comprueba moneda, zona horaria, límites del periodo, filtros y paginación.                                                                              |

## Reintentos

Una respuesta perdida, un tiempo de espera o una interrupción no prueban que una modificación falló. Consulta el estado y utiliza únicamente el mecanismo de reintento seguro que declare la operación. No inventes claves nuevas ni ejecutes un bucle de reintentos para un cambio incierto.

## Pedir ayuda

Anota el nombre de la operación y el código de error declarado. No compartas tokens, códigos de acceso, contraseñas, enlaces de aprobación de un solo uso ni el contenido de tus transacciones en reportes públicos. Puedes contactar a [soporte de Fidy](mailto:obarboza@fidyapp.com).
