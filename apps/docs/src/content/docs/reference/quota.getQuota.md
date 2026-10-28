---
title: quota.getQuota
description: Contrato, permisos y respuestas de quota.getQuota.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Read your four independent Free allowances and exact America/Bogota month reset. This query consumes no canonical unit and remains available at zero remaining; Trial and Pro are uncapped.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `quota.getQuota`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy quota getQuota --help`.
- API: `GET https://api.fidyapp.com/quota`.

## Parámetros HTTP

```json
[]
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
                "accessTier": {
                  "$ref": "#/components/schemas/AccessTier"
                },
                "canonicalCalls": {
                  "$ref": "#/components/schemas/Union_18"
                },
                "forwardedEmails": {
                  "$ref": "#/components/schemas/Union_18"
                },
                "hostedHistoryTurns": {
                  "$ref": "#/components/schemas/Union_18"
                },
                "mediaSubmissions": {
                  "$ref": "#/components/schemas/Union_18"
                }
              },
              "required": [
                "accessTier",
                "forwardedEmails",
                "mediaSubmissions",
                "hostedHistoryTurns",
                "canonicalCalls"
              ],
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
