---
title: connections.getConnection
description: Contrato, permisos y respuestas de connections.getConnection.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Inspect one caller-owned Connection by stable identity.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `connections.getConnection`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy connections getConnection --help`.
- API: `GET https://api.fidyapp.com/connections/{id}`.

## Parámetros HTTP

```json
[
  {
    "in": "path",
    "name": "id",
    "required": true,
    "schema": {
      "$ref": "#/components/schemas/ConnectionId"
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
              "$ref": "#/components/schemas/Connection"
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
