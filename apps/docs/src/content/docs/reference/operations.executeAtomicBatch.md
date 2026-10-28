---
title: operations.executeAtomicBatch
description: Contrato, permisos y respuestas de operations.executeAtomicBatch.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Execute a non-empty ordered set of canonical mutations in one User-scoped atomic commit. Use this when several state changes must commit together; each child keeps its own scope, Subscription tier, confirmation policy, validation, and canonical failure. Queries and nested batches are not valid children.

## Acceso

Se evalúan los permisos de cada operación del lote.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **required**.

## Interfaces

- MCP: herramienta `operations.executeAtomicBatch`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy operations executeAtomicBatch --help`.
- API: `POST https://api.fidyapp.com/operations/atomic-batch`.

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
        "additionalProperties": false,
        "properties": {
          "calls": {
            "items": {
              "$ref": "#/components/schemas/Union_20"
            },
            "maxItems": 12,
            "minItems": 1,
            "prefixItems": [
              {
                "$ref": "#/components/schemas/Union_20"
              }
            ],
            "type": "array"
          }
        },
        "required": ["calls"],
        "type": "object"
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
          "additionalProperties": false,
          "properties": {
            "data": {
              "additionalProperties": false,
              "properties": {
                "results": {
                  "items": {
                    "$ref": "#/components/schemas/Union_21"
                  },
                  "maxItems": 12,
                  "minItems": 1,
                  "prefixItems": [
                    {
                      "$ref": "#/components/schemas/Union_21"
                    }
                  ],
                  "type": "array"
                }
              },
              "required": ["results"],
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
          "anyOf": [
            {
              "$ref": "#/components/schemas/AtomicBatchRejectedEncoded"
            },
            {
              "$ref": "#/components/schemas/ValidationFailedEncoded"
            }
          ]
        }
      }
    },
    "description": "AtomicBatchRejected | ValidationFailed"
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
