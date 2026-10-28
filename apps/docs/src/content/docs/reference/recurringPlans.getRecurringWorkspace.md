---
title: recurringPlans.getRecurringWorkspace
description: Contrato, permisos y respuestas de recurringPlans.getRecurringWorkspace.
---

Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.

Read a recurring month and Currency-separated totals. Get plan IDs from data.document.plans and expectedRevision from data.document.revision before editing; never ask the User. Follow previousMonth for older unresolved items.

## Acceso

Permiso: **read**.

Plan requerido: **free**. Tipo: **query**.

Confirmación sensible: **not-required**.

## Interfaces

- MCP: herramienta `recurringPlans.getRecurringWorkspace`; los argumentos exactos se descubren en tu cliente según tus permisos.
- CLI: `fidy recurringPlans getRecurringWorkspace --help`.
- API: `GET https://api.fidyapp.com/recurring-plans`.

## Parámetros HTTP

```json
[
  {
    "in": "query",
    "name": "month",
    "required": true,
    "schema": {
      "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "previousMonth",
    "required": false,
    "schema": {
      "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "search",
    "required": false,
    "schema": {
      "maxLength": 120,
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "kind",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Union_16"
    }
  },
  {
    "in": "query",
    "name": "frequency",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Union_17"
    }
  },
  {
    "in": "query",
    "name": "currency",
    "required": false,
    "schema": {
      "$ref": "#/components/schemas/Currency"
    }
  },
  {
    "in": "query",
    "name": "categoryId",
    "required": false,
    "schema": {
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "accountId",
    "required": false,
    "schema": {
      "type": "string"
    }
  },
  {
    "in": "query",
    "name": "status",
    "required": false,
    "schema": {
      "enum": ["upcoming", "unconfirmed", "partial", "completed", "skipped"],
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
                "document": {
                  "$ref": "#/components/schemas/Objects_49"
                },
                "invalidFulfillmentIds": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                "matches": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "fact": {
                        "additionalProperties": false,
                        "properties": {
                          "categoryId": {
                            "type": "string"
                          },
                          "counterparty": {
                            "type": "string"
                          },
                          "date": {
                            "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                            "type": "string"
                          },
                          "direction": {
                            "enum": ["inflow", "outflow"],
                            "type": "string"
                          },
                          "id": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "money": {
                            "$ref": "#/components/schemas/Money_2"
                          }
                        },
                        "required": ["id", "money", "date", "direction", "categoryId"],
                        "type": "object"
                      },
                      "item": {
                        "$ref": "#/components/schemas/Objects_54"
                      }
                    },
                    "required": ["item", "fact"],
                    "type": "object"
                  },
                  "type": "array"
                },
                "matchesComplete": {
                  "type": "boolean"
                },
                "month": {
                  "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
                  "type": "string"
                },
                "occurrences": {
                  "items": {
                    "$ref": "#/components/schemas/Objects_54"
                  },
                  "type": "array"
                },
                "previous": {
                  "items": {
                    "$ref": "#/components/schemas/Objects_54"
                  },
                  "type": "array"
                },
                "previousMonth": {
                  "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
                  "type": "string"
                },
                "summary": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "completed": {
                        "$ref": "#/components/schemas/Money_2"
                      },
                      "currency": {
                        "$ref": "#/components/schemas/Currency"
                      },
                      "estimated": {
                        "$ref": "#/components/schemas/Money_2"
                      },
                      "kind": {
                        "$ref": "#/components/schemas/Union_16"
                      },
                      "remaining": {
                        "$ref": "#/components/schemas/Money_2"
                      },
                      "unknown": {
                        "maximum": 9007199254740991,
                        "minimum": -9007199254740991,
                        "type": "integer"
                      }
                    },
                    "required": [
                      "kind",
                      "currency",
                      "completed",
                      "remaining",
                      "estimated",
                      "unknown"
                    ],
                    "type": "object"
                  },
                  "type": "array"
                },
                "today": {
                  "type": "string"
                }
              },
              "required": [
                "document",
                "month",
                "today",
                "occurrences",
                "previous",
                "summary",
                "invalidFulfillmentIds",
                "matches",
                "matchesComplete"
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
