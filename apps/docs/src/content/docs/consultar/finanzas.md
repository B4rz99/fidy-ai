---
title: Consultar mis finanzas
description: Consulta transacciones por moneda, fechas y categoría sin mezclar denominaciones.
---

Necesitas el permiso `read`. Empieza por una pregunta concreta:

> Consulta mis transacciones de salida en COP de este mes. Indica las fechas usadas, si hay más páginas y qué registros respaldan el resultado.

## Con MCP

El agente puede usar `transactions.listTransactions`, `transactions.getTransaction` y `transactions.searchTransactions`. Pídele que identifique los filtros y complete la paginación antes de resumir todo un periodo.

Para una transacción puntual, usa su identificador. Para buscar por texto o categoría, consulta los parámetros exactos de la herramienta que descubra tu cliente.

## Con CLI

```sh
fidy transactions listTransactions --currency COP --json
fidy transactions listTransactions --help
```

Para un intervalo explícito, guarda en `consulta.json`:

```json
{
  "query": {
    "currency": "COP",
    "from": "2026-10-01T05:00:00.000Z",
    "to": "2026-11-01T05:00:00.000Z"
  }
}
```

```sh
fidy transactions listTransactions --input consulta.json --json
```

Este ejemplo abarca octubre de 2026 en Bogotá. `from` es inclusivo y `to` exclusivo. Ajusta las fechas al periodo que buscas. Si la respuesta ofrece otra página, continúa con su cursor conservando los mismos filtros.

## Interpreta el resultado

- Mantén cada moneda separada: no sumes COP y USD como si fueran equivalentes. Fidy no aplica una conversión implícita.
- Los montos del contrato son texto decimal exacto junto a su moneda. No conviertas los valores a aritmética de punto flotante para calcular totales.
- Un resultado vacío no demuestra que no hubo actividad: puede faltar información registrada o haber filtros que la excluyan.
- Un resumen de una sola página no representa necesariamente todo el periodo.
- Si encuentras un dato incorrecto, [corrige la transacción existente](/transacciones/registrar-corregir).

Referencia: [listar transacciones](/reference/transactions.listtransactions) y [buscar](/reference/transactions.searchtransactions).
