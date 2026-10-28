---
title: transactions.linkTransactions
description: Contrato, permisos y respuestas de transactions.linkTransactions.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Link two exact owned Transactions that describe one purchase. Both originals and every SourceAttestation remain retained; ordinary history, Dashboard calculations, and Budget status use one effective Transaction under the earliest-created id.

## Acceso

Permiso: **write**.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `transactions.linkTransactions`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy transactions linkTransactions --help`.
- API: `POST https://api.fidyapp.com/transactions/link`.

## Parámetros HTTP

```json
[]
```

## Cuerpo HTTP

```json
{
  "content": {
    "application/json": {
      "schema": {
        "$ref": "#/components/schemas/TransactionPairInput"
      }
    }
  },
  "required": true
}
```

## Respuestas y errores declarados

```json
{
  "200": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/Objects_22"
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
  "404": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/NotFoundEncoded"
        }
      }
    },
    "description": "NotFound"
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
