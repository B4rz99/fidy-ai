---
title: Registrar y corregir transacciones
description: Registra una transacción y corrige el mismo registro sin duplicarlo.
---

Necesitas `write` para crear o modificar y `read` para consultar el resultado. Si tu conexión no tiene esos permisos, [autoriza una nueva conexión](/acceso/permisos).

## Registrar con MCP

Pide a tu agente, por ejemplo:

> Registra una transacción de salida de 25.000 COP, ocurrida hoy a las 10:00 en Bogotá. Notas: almuerzo. Muéstrame el registro creado.

El agente debe usar `transactions.createTransaction`. Comprueba el monto, la moneda, la dirección, la fecha y la categoría del resultado. Conserva su identificador para corregir el mismo registro. Si no conoces la contraparte, omítela; «almuerzo» describe el propósito y no identifica una persona u organización.

## Corregir con MCP

1. Identifica la transacción con `transactions.listTransactions` o `transactions.getTransaction`.
2. Pide el cambio concreto: «Corrige el monto de esta transacción a 26.000 COP; conserva los demás datos». El agente debe usar `transactions.updateTransaction` con su revisión actual.
3. Revisa el cambio exacto en la confirmación nativa que presenta tu cliente y selecciona **Confirmar la acción** únicamente si corresponde a tu decisión. Un «sí» escrito en el chat no reemplaza esta interacción.
4. Si cancelas, rechazas o dejas la casilla sin confirmar, el cambio no queda autorizado. Si el cliente no admite la interacción requerida, la acción se rechaza; no hay un enlace alternativo de aprobación en el navegador.
5. Consulta otra vez el registro y comprueba el cambio.

Una corrección modifica la misma transacción. No crees otra para sustituirla. La revisión evita sobrescribir cambios posteriores: si hay un conflicto, consulta la versión actual y decide nuevamente. La información de procedencia se conserva según sus reglas de retención.

## Registrar con CLI

El siguiente ejemplo usa datos ficticios. Sustituye la fecha por la fecha real de tu transacción, expresada como instante con zona horaria:

```sh
fidy transactions createTransaction --amount 25000 --currency COP --direction outflow --occurred-at 2026-10-27T15:00:00.000Z --json
```

Para una corrección, guarda en `correccion.json` el identificador y la revisión devueltos al consultar tu transacción. Reemplaza ambos valores del ejemplo:

```json
{
  "params": { "id": "00000000-0000-4000-8000-000000000001" },
  "payload": {
    "expectedRevision": 0,
    "changes": { "money": { "amount": "26000", "currency": "COP" } }
  }
}
```

```sh
fidy transactions updateTransaction --input correccion.json --json
fidy transactions listTransactions --currency COP --json
```

La confirmación nativa OAuth descrita arriba corresponde a MCP; la CLI usa su PAT y el servidor aplica la política de ese tipo de acceso. Consulta `--help` para el contrato completo del ejecutable instalado.

## Si no llega la respuesta

Un cambio puede completarse aunque su respuesta se pierda. Consulta el estado antes de intentarlo de nuevo. No repitas automáticamente una creación ni supongas que cancelar el cliente revirtió el servidor.

Referencia: [crear](/reference/transactions.createtransaction), [consultar](/reference/transactions.gettransaction) y [corregir](/reference/transactions.updatetransaction).
