---
title: ingestion.applyReviewEdit
description: Contrato, permisos y respuestas de ingestion.applyReviewEdit.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Autosave a draft, skip pending items, or restore skipped items using their observed revisions. Every item must remain unexpired. Bulk decisions are atomic; an uncertain outcome requires a reread.

## Acceso

Permiso: **write**.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **required**.

## Interfaces

- MCP: herramienta `ingestion.applyReviewEdit`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy ingestion applyReviewEdit --help`.
- API: `POST https://api.fidyapp.com/ingestion/review-workspace/edits`.

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
        "$ref": "#/components/schemas/Union_13"
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
          "$ref": "#/components/schemas/Objects_33"
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
