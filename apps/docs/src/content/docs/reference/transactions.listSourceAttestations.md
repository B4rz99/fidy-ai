---
title: transactions.listSourceAttestations
description: Contrato, permisos y respuestas de transactions.listSourceAttestations.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Explain which captured market, locale, IANA time zone, source details, and interpretation revision produced one owned Transaction, including after its user-facing deletion. SourceAttestations are immutable.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `transactions.listSourceAttestations`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy transactions listSourceAttestations --help`.
- API: `GET https://api.fidyapp.com/transactions/{id}/source-attestations`.

## Parámetros HTTP

```json
[
  {
    "in": "path",
    "name": "id",
    "required": true,
    "schema": {
      "$ref": "#/components/schemas/TransactionId"
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
                "$ref": "#/components/schemas/SourceAttestation"
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
