---
title: budgets.updateBudget
description: Contrato, permisos y respuestas de budgets.updateBudget.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Replace a Budget's Category and positive cap. Supply month (YYYY-MM) to edit only that saved month and groupName to organize it. Supply groupCategoryIds with groupName to rename the caller-owned category collection across months. Currency is immutable; reached monthly alert marks remain latched.

## Acceso

Permiso: **write**.

Plan requerido: **free**. Tipo: **mutation**.

Confirmación sensible: **required**.

## Interfaces

- MCP: herramienta `budgets.updateBudget`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy budgets updateBudget --help`.
- API: `PUT https://api.fidyapp.com/budgets/{id}`.

## Parámetros HTTP

```json
[
  {
    "in": "path",
    "name": "id",
    "required": true,
    "schema": {
      "$ref": "#/components/schemas/BudgetId"
    }
  }
]
```

## Cuerpo HTTP

```json
{
  "content": {
    "application/json": {
      "schema": {
        "$ref": "#/components/schemas/UpdateBudgetInput_1"
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
          "$ref": "#/components/schemas/Objects_11"
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
