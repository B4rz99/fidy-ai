---
title: memory.remember
description: Contrato, permisos y respuestas de memory.remember.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Retain formatting-normalized free text the User explicitly chose as durable economic context. Warn the User not to include credentials or unnecessary sensitive information; never solicit those values.

## Acceso

Permiso: **write**.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `memory.remember`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy memory remember --help`.
- API: `POST https://api.fidyapp.com/memories`.

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
        "$ref": "#/components/schemas/RememberInput"
      }
    }
  },
  "required": true
}
```

## Respuestas y errores declarados

```json
{
  "201": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/Objects_57"
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
  "409": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MemoryCapacityExceededApiEncoded"
        }
      }
    },
    "description": "MemoryCapacityExceededApi"
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
