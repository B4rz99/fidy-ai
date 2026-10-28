---
title: categories.createKeywordRule
description: Contrato, permisos y respuestas de categories.createKeywordRule.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Teach future capture that a counterparty containing this case- and accent-insensitive keyword belongs to one stable Category. More specific longer matching keywords win.

## Acceso

Permiso: **write**.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `categories.createKeywordRule`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy categories createKeywordRule --help`.
- API: `POST https://api.fidyapp.com/category-keyword-rules`.

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
        "$ref": "#/components/schemas/CreateKeywordRuleInput"
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
          "$ref": "#/components/schemas/Objects_4"
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
