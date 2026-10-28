---
title: budgets.getBudgetStatus
description: Contrato, permisos y respuestas de budgets.getBudgetStatus.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Answer Budget status for an optional month (YYYY-MM), defaulting to the current month. Uninitialized plans preview previous planned amounts; an explicit month-scoped write freezes the plan. Supply the IANA time zone whose calendar boundaries apply; optional Category and Currency filters combine, and omitted Currency returns separate deterministically ordered results without conversion or aggregation.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `budgets.getBudgetStatus`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy budgets getBudgetStatus --help`.
- API: `GET https://api.fidyapp.com/budget-status`.

## Parámetros HTTP

```json
[
  {
    "in": "query",
    "name": "categoryId",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/CategoryId"
    }
  },
  {
    "in": "query",
    "name": "currency",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Currency"
    }
  },
  {
    "in": "query",
    "name": "timeZone",
    "required": true,
    "schema": {
      "$ref": "#/components/schemas/IanaTimeZone"
    }
  },
  {
    "in": "query",
    "name": "month",
    "required": false,
    "schema": {
      "type": "string"
    }
  }
]
```

## Cuerpo HTTP

Esta operación no declara cuerpo HTTP.

## Respuestas y errores declarados

```json
{
  "200": {
    "content": {
      "application/json": {
        "schema": {
          "additionalProperties": false,
          "properties": {
            "data": {
              "$ref": "#/components/schemas/BudgetStatusReport"
            },
            "next": {
              "$ref": "#/components/schemas/Arrays_"
            }
          },
          "required": ["data", "next"],
          "type": "object"
        }
      }
    },
    "description": "Success"
  },
  "400": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ValidationFailedEncoded"
        }
      }
    },
    "description": "ValidationFailed"
  },
  "401": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UnauthenticatedEncoded"
        }
      }
    },
    "description": "Unauthenticated"
  },
  "402": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PaywallRequiredEncoded"
        }
      }
    },
    "description": "PaywallRequired"
  },
  "403": {
    "content": {
      "application/json": {
        "schema": {
          "anyOf": [
            {
              "$ref": "#/components/schemas/ConsentRequiredEncoded"
            },
            {
              "$ref": "#/components/schemas/UserActionRequiredEncoded"
            },
            {
              "$ref": "#/components/schemas/ScopeMissingEncoded"
            }
          ]
        }
      }
    },
    "description": "ConsentRequired | UserActionRequired | ScopeMissing"
  },
  "429": {
    "content": {
      "application/json": {
        "schema": {
          "anyOf": [
            {
              "$ref": "#/components/schemas/QuotaExhaustedEncoded"
            },
            {
              "$ref": "#/components/schemas/ResourceLimitedEncoded"
            }
          ]
        }
      }
    },
    "description": "QuotaExhausted | ResourceLimited"
  },
  "503": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UnavailableEncoded"
        }
      }
    },
    "description": "Unavailable"
  }
}
```

Los `$ref` se resuelven en [los esquemas](/referencia/esquemas) y en el [OpenAPI público](/reference/openapi.json).
