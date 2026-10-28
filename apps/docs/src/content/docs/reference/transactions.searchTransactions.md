---
title: transactions.searchTransactions
description: Contrato, permisos y respuestas de transactions.searchTransactions.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Search the caller's FinancialRecord by literal Counterparty or notes text. Supply 2–80 characters; results are bounded and ordered newest first. Follow the returned continuation to browse further matches.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `transactions.searchTransactions`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy transactions searchTransactions --help`.
- API: `GET https://api.fidyapp.com/transactions/search`.

## Parámetros HTTP

```json
[
  {
    "in": "query",
    "name": "q",
    "required": true,
    "schema": {
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "cursor",
    "required": false,
    "schema": {
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|[0-9a-f-]{36}$",
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
              "items": {
                "$ref": "#/components/schemas/Transaction"
              },
              "type": "array"
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
              "$ref": "#/components/schemas/ResourceLimitedEncoded"
            },
            {
              "$ref": "#/components/schemas/QuotaExhaustedEncoded"
            }
          ]
        }
      }
    },
    "description": "ResourceLimited | QuotaExhausted"
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
