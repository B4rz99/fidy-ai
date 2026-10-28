---
title: ingestion.listNeedsReviewItems
description: Contrato, permisos y respuestas de ingestion.listNeedsReviewItems.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

List up to 100 of the caller's visible statement rows and forwarded emails requiring review, followed by retained resolution metadata. Use offset and limit to page, and status to filter. For one clarification question, request status=pending and limit=1. Pending statement items include parser-bounded original row evidence and email items reference their expiring IngestSample.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `ingestion.listNeedsReviewItems`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy ingestion listNeedsReviewItems --help`.
- API: `GET https://api.fidyapp.com/ingestion/needs-review`.

## Parámetros HTTP

```json
[
  {
    "in": "query",
    "name": "status",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Union_4"
    }
  },
  {
    "in": "query",
    "name": "offset",
    "required": false,
    "schema": {
      "pattern": "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$",
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "limit",
    "required": false,
    "schema": {
      "pattern": "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$",
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
                "$ref": "#/components/schemas/NeedsReviewItem"
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
