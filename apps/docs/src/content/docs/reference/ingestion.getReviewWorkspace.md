---
title: ingestion.getReviewWorkspace
description: Contrato, permisos y respuestas de ingestion.getReviewWorkspace.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Read the ingestion inbox ordered by original evidence expiry, or retained created, skipped and expired history. Returns metadata only, with a complete pending count and bounded pagination.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `ingestion.getReviewWorkspace`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy ingestion getReviewWorkspace --help`.
- API: `GET https://api.fidyapp.com/ingestion/review-workspace`.

## Parámetros HTTP

```json
[
  {
    "in": "query",
    "name": "status",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Union_3"
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
              "additionalProperties": false,
              "properties": {
                "items": {
                  "items": {
                    "$ref": "#/components/schemas/Union_11"
                  },
                  "type": "array"
                },
                "pendingCount": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "total": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                }
              },
              "required": ["pendingCount", "total", "items"],
              "type": "object"
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
