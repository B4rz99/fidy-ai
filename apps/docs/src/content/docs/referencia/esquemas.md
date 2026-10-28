---
title: Esquemas del contrato
description: Esquemas alcanzables desde las operaciones para agentes.
---

Los nombres de esquema corresponden al OpenAPI público.

```json
{
  "CreateBudgetInput_1": {
    "additionalProperties": false,
    "properties": {
      "cap": {
        "$ref": "#/components/schemas/Money_2"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "groupName": {
        "maxLength": 64,
        "minLength": 1,
        "type": "string"
      },
      "month": {
        "type": "string"
      }
    },
    "required": ["categoryId", "cap"],
    "type": "object"
  },
  "Objects_9": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Budget"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "ValidationFailedEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["ValidationFailed"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["validation_failed"],
            "type": "string"
          },
          "fields": {
            "description": "One entry per offending value. Nothing was written, so correct every one of them and send the whole request again rather than only the parts named here.",
            "items": {
              "$ref": "#/components/schemas/FieldIssue"
            },
            "type": "array"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message", "fields"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "UnauthenticatedEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["Unauthenticated"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["unauthenticated"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "PaywallRequiredEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["PaywallRequired"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["paywall_required"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "ConsentRequiredEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["ConsentRequired"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["consent_required"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "UserActionRequiredEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["UserActionRequired"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["user_action_required"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "ScopeMissingEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["ScopeMissing"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["scope_missing"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "NotFoundEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["NotFound"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["not_found"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "QuotaExhaustedEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["QuotaExhausted"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "allowance": {
            "enum": [
              "forwarded_email",
              "media_submission",
              "hosted_history_turn",
              "canonical_call"
            ],
            "type": "string"
          },
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["quota_exhausted"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "resetsAt": {
            "type": "string"
          }
        },
        "required": ["code", "message", "allowance", "resetsAt"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "ResourceLimitedEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["ResourceLimited"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["rate_limited"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "retryAfterSeconds": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "UnavailableEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["Unavailable"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "description": "What went wrong, drawn from one closed set shared by every operation: `validation_failed`, `unauthenticated`, `scope_missing`, `consent_required`, `user_action_required`, `paywall_required`, `rate_limited`, `quota_exhausted`, `not_found`, `dashboard_uninitialized`, `unavailable`. Branch on this rather than on the status or the message; the set is small enough to cover exhaustively.",
            "enum": ["unavailable"],
            "type": "string"
          },
          "message": {
            "description": "Why the call failed and what to do about it, written to you rather than to the user. Decide your next move from it; do not relay it verbatim.",
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "retryAfterSeconds": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "BudgetId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_13": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/BudgetId"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Budget": {
    "additionalProperties": false,
    "properties": {
      "cap": {
        "$ref": "#/components/schemas/Money_2"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "groupName": {
        "maxLength": 64,
        "minLength": 1,
        "type": "string"
      },
      "id": {
        "$ref": "#/components/schemas/BudgetId"
      },
      "updatedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["id", "categoryId", "cap", "createdAt", "updatedAt"],
    "type": "object"
  },
  "Arrays_": {
    "description": "Where to go next: up to three canonical operations worth calling after this one, best first. Empty when there is nothing worth suggesting, which is an answer rather than an omission. Each entry has passed the target-input and caller-authorization checkpoint.",
    "items": {
      "$ref": "#/components/schemas/SuggestedOperation"
    },
    "maxItems": 3,
    "type": "array"
  },
  "CategoryId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Currency": {
    "description": "A recognized monetary ISO 4217 alphabetic code. It determines the maximum fractional precision of Money and does not imply that fidy operates in that currency's markets.",
    "enum": [
      "AED",
      "AFN",
      "ALL",
      "AMD",
      "AOA",
      "ARS",
      "AUD",
      "AWG",
      "AZN",
      "BAM",
      "BBD",
      "BDT",
      "BHD",
      "BIF",
      "BMD",
      "BND",
      "BOB",
      "BRL",
      "BSD",
      "BTN",
      "BWP",
      "BYN",
      "BZD",
      "CAD",
      "CDF",
      "CHF",
      "CLP",
      "CNY",
      "COP",
      "CRC",
      "CUP",
      "CVE",
      "CZK",
      "DJF",
      "DKK",
      "DOP",
      "DZD",
      "EGP",
      "ERN",
      "ETB",
      "EUR",
      "FJD",
      "FKP",
      "GBP",
      "GEL",
      "GHS",
      "GIP",
      "GMD",
      "GNF",
      "GTQ",
      "GYD",
      "HKD",
      "HNL",
      "HTG",
      "HUF",
      "IDR",
      "ILS",
      "INR",
      "IQD",
      "IRR",
      "ISK",
      "JMD",
      "JOD",
      "JPY",
      "KES",
      "KGS",
      "KHR",
      "KMF",
      "KPW",
      "KRW",
      "KWD",
      "KYD",
      "KZT",
      "LAK",
      "LBP",
      "LKR",
      "LRD",
      "LSL",
      "LYD",
      "MAD",
      "MDL",
      "MGA",
      "MKD",
      "MMK",
      "MNT",
      "MOP",
      "MRU",
      "MUR",
      "MVR",
      "MWK",
      "MXN",
      "MYR",
      "MZN",
      "NAD",
      "NGN",
      "NIO",
      "NOK",
      "NPR",
      "NZD",
      "OMR",
      "PAB",
      "PEN",
      "PGK",
      "PHP",
      "PKR",
      "PLN",
      "PYG",
      "QAR",
      "RON",
      "RSD",
      "RUB",
      "RWF",
      "SAR",
      "SBD",
      "SCR",
      "SDG",
      "SEK",
      "SGD",
      "SHP",
      "SLE",
      "SOS",
      "SRD",
      "SSP",
      "STN",
      "SVC",
      "SYP",
      "SZL",
      "THB",
      "TJS",
      "TMT",
      "TND",
      "TOP",
      "TRY",
      "TTD",
      "TWD",
      "TZS",
      "UAH",
      "UGX",
      "USD",
      "UYU",
      "UYW",
      "UZS",
      "VED",
      "VES",
      "VND",
      "VUV",
      "WST",
      "XAF",
      "XCD",
      "XCG",
      "XOF",
      "XPF",
      "YER",
      "ZAR",
      "ZMW",
      "ZWG"
    ],
    "type": "string"
  },
  "IanaTimeZone": {
    "type": "string"
  },
  "BudgetStatusReport": {
    "additionalProperties": false,
    "properties": {
      "cashFlow": {
        "additionalProperties": false,
        "properties": {
          "expenses": {
            "items": {
              "$ref": "#/components/schemas/Money_2"
            },
            "type": "array"
          },
          "income": {
            "items": {
              "$ref": "#/components/schemas/Money_2"
            },
            "type": "array"
          }
        },
        "required": ["income", "expenses"],
        "type": "object"
      },
      "initialized": {
        "type": "boolean"
      },
      "period": {
        "$ref": "#/components/schemas/AppliedBudgetMonth"
      },
      "statuses": {
        "items": {
          "$ref": "#/components/schemas/BudgetStatus"
        },
        "type": "array"
      }
    },
    "required": ["period", "statuses", "cashFlow"],
    "type": "object"
  },
  "UpdateBudgetInput_1": {
    "additionalProperties": false,
    "properties": {
      "cap": {
        "$ref": "#/components/schemas/Money_2"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "groupCategoryIds": {
        "items": {
          "$ref": "#/components/schemas/CategoryId"
        },
        "maxItems": 128,
        "minItems": 1,
        "type": "array"
      },
      "groupCurrency": {
        "$ref": "#/components/schemas/Currency"
      },
      "groupName": {
        "maxLength": 64,
        "minLength": 1,
        "type": "string"
      },
      "month": {
        "type": "string"
      }
    },
    "required": ["categoryId", "cap"],
    "type": "object"
  },
  "Objects_11": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Budget"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "CreateKeywordRuleInput": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "keyword": {
        "$ref": "#/components/schemas/CategoryKeyword"
      }
    },
    "required": ["keyword", "categoryId"],
    "type": "object"
  },
  "Objects_4": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/KeywordRule"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "KeywordRuleId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_8": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/KeywordRuleId"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Category": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "label": {
        "$ref": "#/components/schemas/CategoryLabel"
      }
    },
    "required": ["id", "label"],
    "type": "object"
  },
  "KeywordRule": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "$ref": "#/components/schemas/KeywordRuleId"
      },
      "keyword": {
        "$ref": "#/components/schemas/CategoryKeyword"
      },
      "updatedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["id", "keyword", "categoryId", "createdAt", "updatedAt"],
    "type": "object"
  },
  "UpdateKeywordRuleInput": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "keyword": {
        "$ref": "#/components/schemas/CategoryKeyword"
      }
    },
    "required": ["keyword", "categoryId"],
    "type": "object"
  },
  "Objects_6": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/KeywordRule"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "ConnectInstitutionInput": {
    "additionalProperties": false,
    "properties": {
      "institutionId": {
        "$ref": "#/components/schemas/InstitutionId"
      }
    },
    "required": ["institutionId"],
    "type": "object"
  },
  "Objects_14": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/ConnectInstitutionResult"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "ConnectionId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Connection": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/ConnectionId"
      },
      "institutionId": {
        "$ref": "#/components/schemas/InstitutionId"
      },
      "state": {
        "$ref": "#/components/schemas/ConnectionState"
      }
    },
    "required": ["id", "institutionId", "state"],
    "type": "object"
  },
  "Account": {
    "additionalProperties": false,
    "properties": {
      "connectionId": {
        "$ref": "#/components/schemas/ConnectionId"
      },
      "id": {
        "$ref": "#/components/schemas/AccountId"
      }
    },
    "required": ["id", "connectionId"],
    "type": "object"
  },
  "InstitutionSummary": {
    "additionalProperties": false,
    "properties": {
      "availability": {
        "enum": ["available", "unavailable"],
        "type": "string"
      },
      "connection": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "id": {
                "$ref": "#/components/schemas/ConnectionId"
              },
              "state": {
                "$ref": "#/components/schemas/ConnectionState"
              }
            },
            "required": ["id", "state"],
            "type": "object"
          },
          {
            "type": "null"
          }
        ]
      },
      "displayName": {
        "minLength": 1,
        "type": "string"
      },
      "id": {
        "$ref": "#/components/schemas/InstitutionId"
      }
    },
    "required": ["id", "displayName", "availability", "connection"],
    "type": "object"
  },
  "DashboardEdit": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/SetTitle"
      },
      {
        "$ref": "#/components/schemas/AddWidget"
      },
      {
        "$ref": "#/components/schemas/RemoveWidget"
      },
      {
        "$ref": "#/components/schemas/MoveWidget"
      },
      {
        "$ref": "#/components/schemas/SwapWidgets"
      },
      {
        "$ref": "#/components/schemas/ResizeRegion"
      },
      {
        "$ref": "#/components/schemas/UpdateWidget"
      }
    ]
  },
  "Objects_18": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/DashboardDocument"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "DashboardDocument": {
    "additionalProperties": false,
    "properties": {
      "layout": {
        "$ref": "#/components/schemas/LayoutNode"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      }
    },
    "required": ["title", "layout"],
    "type": "object"
  },
  "DashboardUninitializedEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["DashboardUninitialized"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "enum": ["dashboard_uninitialized"],
            "type": "string"
          },
          "message": {
            "minLength": 1,
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "DashboardView": {
    "additionalProperties": false,
    "properties": {
      "context": {
        "$ref": "#/components/schemas/DashboardViewContext"
      },
      "layout": {
        "$ref": "#/components/schemas/DashboardViewLayout"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      }
    },
    "required": ["title", "context", "layout"],
    "type": "object"
  },
  "Objects_15": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/DashboardDocument"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "DashboardCatalogEntry": {
    "additionalProperties": false,
    "properties": {
      "description": {
        "maxLength": 160,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "id": {
        "enum": [
          "monthly-spending",
          "restaurant-budget-cop",
          "recent-transactions",
          "monthly-outflows"
        ],
        "type": "string"
      },
      "name": {
        "maxLength": 160,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "widget": {
        "$ref": "#/components/schemas/WidgetTemplate"
      }
    },
    "required": ["id", "name", "description", "widget"],
    "type": "object"
  },
  "User": {
    "additionalProperties": false,
    "properties": {
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "$ref": "#/components/schemas/UserId"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "trialPeriod": {
        "$ref": "#/components/schemas/TrialPeriod"
      }
    },
    "required": ["id", "serviceMarket", "locale", "timeZone", "trialPeriod", "createdAt"],
    "type": "object"
  },
  "UserPreferences": {
    "additionalProperties": false,
    "properties": {
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "required": ["locale", "timeZone"],
    "type": "object"
  },
  "Objects_3": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/User"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "StatementSubmissionId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_41": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/StatementSubmission"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Union_13": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["Create"],
            "type": "string"
          },
          "categoryId": {
            "$ref": "#/components/schemas/CategoryId"
          },
          "extraction": {
            "$ref": "#/components/schemas/TransactionExtraction_1"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["_tag", "id", "revision", "extraction"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["SaveDraft"],
            "type": "string"
          },
          "draft": {
            "$ref": "#/components/schemas/Objects_31"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["_tag", "id", "revision", "draft"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["Skip"],
            "type": "string"
          },
          "items": {
            "$ref": "#/components/schemas/Arrays_4"
          }
        },
        "required": ["_tag", "items"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["Restore"],
            "type": "string"
          },
          "items": {
            "$ref": "#/components/schemas/Arrays_4"
          }
        },
        "required": ["_tag", "items"],
        "type": "object"
      }
    ]
  },
  "Objects_33": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "items": {
          "$ref": "#/components/schemas/Objects_29"
        },
        "type": "array"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Objects_34": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EmailForwardingAddress"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "EmailForwardingStatus": {
    "additionalProperties": false,
    "properties": {
      "address": {
        "$ref": "#/components/schemas/EmailForwardingAddress"
      },
      "deferredCapacityRemaining": {
        "maximum": 50,
        "minimum": 0,
        "type": "integer"
      },
      "deferredEmails": {
        "maximum": 50,
        "minimum": 0,
        "type": "integer"
      },
      "remainingThisMonth": {
        "maximum": 50,
        "minimum": 0,
        "type": "integer"
      },
      "resetsAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["deferredEmails", "deferredCapacityRemaining", "resetsAt"],
    "type": "object"
  },
  "NeedsReviewItemId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_29": {
    "additionalProperties": false,
    "properties": {
      "draft": {
        "$ref": "#/components/schemas/Objects_31"
      },
      "item": {
        "$ref": "#/components/schemas/Union_11"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "suggestions": {
        "$ref": "#/components/schemas/Objects_31"
      }
    },
    "required": ["item", "revision"],
    "type": "object"
  },
  "Union_3": {
    "enum": ["pending", "created", "skipped", "expired", "history"],
    "type": "string"
  },
  "Union_11": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "expiresAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "preview": {
            "$ref": "#/components/schemas/Objects_30"
          },
          "reason": {
            "type": "string"
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "source": {
            "$ref": "#/components/schemas/Union_12"
          },
          "status": {
            "enum": ["created"],
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "$ref": "#/components/schemas/TransactionId"
          }
        },
        "required": [
          "revision",
          "id",
          "source",
          "timeZone",
          "reason",
          "createdAt",
          "expiresAt",
          "status",
          "transactionId"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "expiresAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "preview": {
            "$ref": "#/components/schemas/Objects_30"
          },
          "reason": {
            "type": "string"
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "source": {
            "$ref": "#/components/schemas/Union_12"
          },
          "status": {
            "enum": ["pending", "skipped", "expired"],
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "not": {}
          }
        },
        "required": [
          "revision",
          "id",
          "source",
          "timeZone",
          "reason",
          "createdAt",
          "expiresAt",
          "status"
        ],
        "type": "object"
      }
    ]
  },
  "StatementSubmission": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "status": {
            "enum": ["queued"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": ["id", "sourceFormat", "parserRevision", "submittedAt", "status"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "startedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "status": {
            "enum": ["processing"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": ["id", "sourceFormat", "parserRevision", "submittedAt", "status", "startedAt"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "accounting": {
            "$ref": "#/components/schemas/StatementAccounting"
          },
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "startedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "status": {
            "enum": ["awaiting-clarification"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": [
          "id",
          "sourceFormat",
          "parserRevision",
          "submittedAt",
          "status",
          "startedAt",
          "accounting"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "accounting": {
            "$ref": "#/components/schemas/StatementAccounting"
          },
          "completedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "startedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "status": {
            "enum": ["abandoned"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": [
          "id",
          "sourceFormat",
          "parserRevision",
          "submittedAt",
          "status",
          "startedAt",
          "completedAt",
          "accounting"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "accounting": {
            "$ref": "#/components/schemas/StatementAccounting"
          },
          "completedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "startedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "status": {
            "enum": ["completed"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": [
          "id",
          "sourceFormat",
          "parserRevision",
          "submittedAt",
          "status",
          "startedAt",
          "completedAt",
          "accounting"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "accounting": {
            "$ref": "#/components/schemas/StatementAccounting"
          },
          "completedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "failureReason": {
            "enum": [
              "unsupported-format",
              "resource-limit",
              "malformed-file",
              "mapping-unavailable",
              "retention-expired"
            ],
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "startedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "status": {
            "enum": ["failed"],
            "type": "string"
          },
          "submittedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          }
        },
        "required": [
          "id",
          "sourceFormat",
          "parserRevision",
          "submittedAt",
          "status",
          "startedAt",
          "completedAt",
          "failureReason"
        ],
        "type": "object"
      }
    ]
  },
  "Union_4": {
    "enum": ["pending", "expired", "resolved", "skipped", "abandoned"],
    "type": "string"
  },
  "NeedsReviewItem": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/StatementNeedsReviewItem"
      },
      {
        "$ref": "#/components/schemas/EmailNeedsReviewItem"
      },
      {
        "$ref": "#/components/schemas/MediaNeedsReviewItem"
      }
    ]
  },
  "ResolveNeedsReviewItemInput": {
    "additionalProperties": false,
    "properties": {
      "extraction": {
        "$ref": "#/components/schemas/TransactionExtraction_1"
      }
    },
    "required": ["extraction"],
    "type": "object"
  },
  "Objects_37": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Transaction"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Objects_39": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/StatementSubmission"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "InsightEventId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_48": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/InsightEvent"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "RecurringDigestReport": {
    "additionalProperties": false,
    "properties": {
      "expiresAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "insightEventId": {
        "$ref": "#/components/schemas/InsightEventId"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "payload": {
        "$ref": "#/components/schemas/RecurringDigestPayload"
      },
      "scheduledAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      }
    },
    "required": [
      "insightEventId",
      "serviceMarket",
      "locale",
      "scheduledAt",
      "expiresAt",
      "payload"
    ],
    "type": "object"
  },
  "ReminderSchedule": {
    "additionalProperties": false,
    "properties": {
      "cadence": {
        "$ref": "#/components/schemas/ReminderCadence"
      },
      "enabled": {
        "type": "boolean"
      },
      "id": {
        "$ref": "#/components/schemas/ScheduleId"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "nextScheduledAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "timing": {
        "$ref": "#/components/schemas/ReminderTiming"
      },
      "version": {
        "$ref": "#/components/schemas/ScheduleVersion"
      }
    },
    "required": [
      "id",
      "version",
      "enabled",
      "cadence",
      "timing",
      "timeZone",
      "serviceMarket",
      "locale",
      "nextScheduledAt"
    ],
    "type": "object"
  },
  "InsightEvent": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/InsightEventId"
      },
      "kind": {
        "enum": [
          "budget-threshold",
          "new-recurring-series",
          "weekly-summary",
          "manual-entry-reminder"
        ],
        "type": "string"
      },
      "lifecycleState": {
        "enum": ["pending", "delivered", "read", "dismissed"],
        "type": "string"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "moneyGroups": {
        "$ref": "#/components/schemas/MoneyGroups"
      },
      "scheduledAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "scheduleId": {
        "$ref": "#/components/schemas/ScheduleId"
      },
      "scheduleVersion": {
        "$ref": "#/components/schemas/ScheduleVersion"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "required": [
      "id",
      "kind",
      "scheduleId",
      "scheduleVersion",
      "serviceMarket",
      "locale",
      "timeZone",
      "scheduledAt",
      "moneyGroups",
      "lifecycleState"
    ],
    "type": "object"
  },
  "DeliveryEvidenceInput": {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "maxLength": 32,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "provider": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "providerMessageId": {
        "maxLength": 256,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "sentAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["sentAt", "channel", "provider", "providerMessageId"],
    "type": "object"
  },
  "Objects_46": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "additionalProperties": false,
        "properties": {
          "deliveryAttempt": {
            "$ref": "#/components/schemas/InsightDeliveryAttempt"
          },
          "insight": {
            "$ref": "#/components/schemas/InsightEvent"
          }
        },
        "required": ["insight", "deliveryAttempt"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Objects_47": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/InsightEvent"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "ReminderScheduleEdit": {
    "additionalProperties": false,
    "properties": {
      "cadence": {
        "$ref": "#/components/schemas/ReminderCadence"
      },
      "expectedVersion": {
        "$ref": "#/components/schemas/ScheduleVersion"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "timing": {
        "$ref": "#/components/schemas/ReminderTiming"
      }
    },
    "required": ["expectedVersion", "cadence", "timing", "timeZone"],
    "type": "object"
  },
  "Objects_44": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/ReminderSchedule"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "MemoryId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_61": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/MemoryId"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "RecallOutput": {
    "items": {
      "$ref": "#/components/schemas/Memory"
    },
    "type": "array"
  },
  "RememberInput": {
    "additionalProperties": false,
    "properties": {
      "text": {
        "$ref": "#/components/schemas/MemoryTextEncoded"
      }
    },
    "required": ["text"],
    "type": "object"
  },
  "Objects_57": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Memory"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "MemoryCapacityExceededApiEncoded": {
    "additionalProperties": false,
    "properties": {
      "_tag": {
        "enum": ["MemoryCapacityExceededApi"],
        "type": "string"
      },
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "enum": ["quota_exhausted"],
            "type": "string"
          },
          "message": {
            "minLength": 1,
            "type": "string"
          }
        },
        "required": ["code", "message"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "ReviseInput": {
    "additionalProperties": false,
    "properties": {
      "text": {
        "$ref": "#/components/schemas/MemoryTextEncoded"
      }
    },
    "required": ["text"],
    "type": "object"
  },
  "Objects_59": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Memory"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Union_20": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/UserPreferences"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["identity.updateUserPreferences"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateKeywordRuleInput"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["categories.createKeywordRule"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_5"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateKeywordRuleInput"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["categories.updateKeywordRule"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_7"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["categories.deleteKeywordRule"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateBudgetInput_1"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["budgets.createBudget"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_10"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateBudgetInput_1"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["budgets.updateBudget"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_12"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["budgets.deleteBudget"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/ConnectInstitutionInput"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["connections.connectInstitution"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "type": "object"
          },
          "operation": {
            "enum": ["dashboard.initializeDashboard"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/DashboardEdit"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["dashboard.applyDashboardEdit"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateTransactionInput_1"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["transactions.createTransaction"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/TransactionPairInput"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["transactions.linkTransactions"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/TransactionPairInput"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["transactions.unlinkTransactions"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_25"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateTransactionInput"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["transactions.updateTransaction"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_27"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["transactions.deleteTransaction"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/Union_13"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["ingestion.applyReviewEdit"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "type": "object"
          },
          "operation": {
            "enum": ["ingestion.enableEmailForwarding"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_36"
              },
              "payload": {
                "$ref": "#/components/schemas/ResolveNeedsReviewItemInput"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["ingestion.resolveNeedsReviewItem"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_38"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["ingestion.skipNeedsReviewItem"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_40"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["ingestion.abandonStatementSubmission"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/ReminderScheduleEdit"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["insights.updateReminderSchedule"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_45"
              },
              "payload": {
                "$ref": "#/components/schemas/DeliveryEvidenceInput"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["insights.markInsightDelivered"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_45"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["insights.markInsightRead"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_45"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["insights.dismissInsight"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/Objects_55"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["recurringPlans.applyRecurringEdit"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/RememberInput"
              }
            },
            "required": ["payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["memory.remember"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_58"
              },
              "payload": {
                "$ref": "#/components/schemas/ReviseInput"
              }
            },
            "required": ["params", "payload"],
            "type": "object"
          },
          "operation": {
            "enum": ["memory.revise"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_60"
              }
            },
            "required": ["params"],
            "type": "object"
          },
          "operation": {
            "enum": ["memory.forget"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "input": {
            "additionalProperties": false,
            "type": "object"
          },
          "operation": {
            "enum": ["subscription.cancelSubscription"],
            "type": "string"
          }
        },
        "required": ["callId", "operation", "input"],
        "type": "object"
      }
    ]
  },
  "Union_21": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["identity.updateUserPreferences"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_3"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["categories.createKeywordRule"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_4"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["categories.updateKeywordRule"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_6"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["categories.deleteKeywordRule"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_8"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["budgets.createBudget"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_9"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["budgets.updateBudget"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_11"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["budgets.deleteBudget"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_13"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["connections.connectInstitution"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_14"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["dashboard.initializeDashboard"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_15"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["dashboard.applyDashboardEdit"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_18"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["transactions.createTransaction"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_20"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["transactions.linkTransactions"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_22"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["transactions.unlinkTransactions"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_23"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["transactions.updateTransaction"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_26"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["transactions.deleteTransaction"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_28"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["ingestion.applyReviewEdit"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_33"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["ingestion.enableEmailForwarding"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_34"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["ingestion.resolveNeedsReviewItem"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_37"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["ingestion.skipNeedsReviewItem"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_39"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["ingestion.abandonStatementSubmission"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_41"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["insights.updateReminderSchedule"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_44"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["insights.markInsightDelivered"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_46"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["insights.markInsightRead"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_47"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["insights.dismissInsight"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_48"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["recurringPlans.applyRecurringEdit"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_56"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["memory.remember"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_57"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["memory.revise"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_59"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["memory.forget"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_61"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "callId": {
            "$ref": "#/components/schemas/AtomicBatchCallId"
          },
          "operation": {
            "enum": ["subscription.cancelSubscription"],
            "type": "string"
          },
          "output": {
            "$ref": "#/components/schemas/Objects_62"
          }
        },
        "required": ["callId", "operation", "output"],
        "type": "object"
      }
    ]
  },
  "AtomicBatchRejectedEncoded": {
    "additionalProperties": false,
    "properties": {
      "error": {
        "additionalProperties": false,
        "properties": {
          "code": {
            "enum": [
              "validation_failed",
              "unauthenticated",
              "scope_missing",
              "consent_required",
              "user_action_required",
              "paywall_required",
              "rate_limited",
              "quota_exhausted",
              "not_found",
              "dashboard_uninitialized",
              "unavailable"
            ],
            "type": "string"
          },
          "failedCallIndex": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "fields": {
            "items": {
              "$ref": "#/components/schemas/FieldIssue"
            },
            "type": "array"
          },
          "message": {
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "operation": {
            "$ref": "#/components/schemas/CanonicalOperationId"
          }
        },
        "required": ["code", "message", "failedCallIndex", "operation", "fields"],
        "type": "object"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["error", "next"],
    "type": "object"
  },
  "AccessTier": {
    "enum": ["free", "pro"],
    "type": "string"
  },
  "Union_18": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["Limited"],
            "type": "string"
          },
          "consumed": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "limit": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "period": {
            "additionalProperties": false,
            "properties": {
              "resetsAt": {
                "type": "string"
              },
              "startsAt": {
                "type": "string"
              }
            },
            "required": ["startsAt", "resetsAt"],
            "type": "object"
          },
          "remaining": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["_tag", "limit", "consumed", "remaining", "period"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "_tag": {
            "enum": ["Uncapped"],
            "type": "string"
          }
        },
        "required": ["_tag"],
        "type": "object"
      }
    ]
  },
  "RecurringSeriesPage": {
    "additionalProperties": false,
    "properties": {
      "cursor": {
        "maxLength": 1024,
        "type": "string"
      },
      "evaluation": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["not-evaluated"],
                "type": "string"
              }
            },
            "required": ["kind"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["updating"],
                "type": "string"
              }
            },
            "required": ["kind"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "asOf": {
                "$ref": "#/components/schemas/UtcTimestamp"
              },
              "kind": {
                "enum": ["current"],
                "type": "string"
              }
            },
            "required": ["kind", "asOf"],
            "type": "object"
          }
        ]
      },
      "series": {
        "items": {
          "$ref": "#/components/schemas/RecurringSeries"
        },
        "type": "array"
      }
    },
    "required": ["series", "evaluation"],
    "type": "object"
  },
  "Objects_55": {
    "additionalProperties": false,
    "properties": {
      "edit": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "id": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              },
              "kind": {
                "enum": ["create"],
                "type": "string"
              },
              "plan": {
                "$ref": "#/components/schemas/Objects_51"
              },
              "seriesId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              }
            },
            "required": ["kind", "id", "plan"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "date": {
                "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                "type": "string"
              },
              "kind": {
                "enum": ["edit"],
                "type": "string"
              },
              "plan": {
                "$ref": "#/components/schemas/Objects_51"
              },
              "planId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              },
              "scope": {
                "enum": ["once", "forward"],
                "type": "string"
              }
            },
            "required": ["kind", "planId", "date", "scope", "plan"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "action": {
                "enum": ["pause", "resume", "stop"],
                "type": "string"
              },
              "date": {
                "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                "type": "string"
              },
              "kind": {
                "enum": ["lifecycle"],
                "type": "string"
              },
              "planId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              }
            },
            "required": ["kind", "planId", "date", "action"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "date": {
                "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                "type": "string"
              },
              "kind": {
                "enum": ["skip"],
                "type": "string"
              },
              "planId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              },
              "skipped": {
                "type": "boolean"
              }
            },
            "required": ["kind", "planId", "date", "skipped"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "fulfillment": {
                "$ref": "#/components/schemas/Objects_53"
              },
              "kind": {
                "enum": ["fulfill"],
                "type": "string"
              },
              "replaces": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              }
            },
            "required": ["kind", "fulfillment"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "fulfillmentId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              },
              "kind": {
                "enum": ["reverse"],
                "type": "string"
              }
            },
            "required": ["kind", "fulfillmentId"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "action": {
                "enum": ["dismiss", "restore", "link"],
                "type": "string"
              },
              "kind": {
                "enum": ["suggestion"],
                "type": "string"
              },
              "planId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              },
              "seriesId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                "type": "string"
              }
            },
            "required": ["kind", "seriesId", "action"],
            "type": "object"
          }
        ]
      },
      "expectedRevision": {
        "maximum": 9007199254740991,
        "minimum": -9007199254740991,
        "type": "integer"
      }
    },
    "required": ["expectedRevision", "edit"],
    "type": "object"
  },
  "Objects_56": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Objects_49"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "Union_16": {
    "enum": ["income", "expense", "transfer"],
    "type": "string"
  },
  "Union_17": {
    "enum": [
      "weekly",
      "fortnightly",
      "twice-monthly",
      "monthly",
      "quarterly",
      "half-yearly",
      "yearly"
    ],
    "type": "string"
  },
  "Objects_49": {
    "additionalProperties": false,
    "properties": {
      "exceptions": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "date": {
              "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
              "type": "string"
            },
            "planId": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
              "type": "string"
            },
            "replacement": {
              "$ref": "#/components/schemas/Objects_51"
            },
            "skipped": {
              "type": "boolean"
            }
          },
          "required": ["planId", "date", "skipped"],
          "type": "object"
        },
        "maxItems": 4096,
        "type": "array"
      },
      "excludedTransactionIds": {
        "items": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
          "type": "string"
        },
        "maxItems": 4096,
        "type": "array"
      },
      "fulfillments": {
        "items": {
          "$ref": "#/components/schemas/Objects_53"
        },
        "maxItems": 4096,
        "type": "array"
      },
      "plans": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "id": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
              "type": "string"
            },
            "pauses": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "from": {
                    "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                    "type": "string"
                  },
                  "through": {
                    "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                    "type": "string"
                  }
                },
                "required": ["from"],
                "type": "object"
              },
              "maxItems": 100,
              "type": "array"
            },
            "revisions": {
              "items": {
                "$ref": "#/components/schemas/Objects_50"
              },
              "maxItems": 100,
              "minItems": 1,
              "prefixItems": [
                {
                  "$ref": "#/components/schemas/Objects_50"
                }
              ],
              "type": "array"
            },
            "stoppedOn": {
              "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
              "type": "string"
            }
          },
          "required": ["id", "revisions", "pauses"],
          "type": "object"
        },
        "maxItems": 100,
        "type": "array"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "suggestions": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "disposition": {
              "enum": ["dismissed", "linked"],
              "type": "string"
            },
            "planId": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
              "type": "string"
            },
            "seriesId": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
              "type": "string"
            }
          },
          "required": ["seriesId", "disposition"],
          "type": "object"
        },
        "maxItems": 4096,
        "type": "array"
      }
    },
    "required": [
      "revision",
      "plans",
      "exceptions",
      "fulfillments",
      "excludedTransactionIds",
      "suggestions"
    ],
    "type": "object"
  },
  "Money_2": {
    "additionalProperties": false,
    "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
    "properties": {
      "amount": {
        "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
        "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      }
    },
    "required": ["amount", "currency"],
    "type": "object"
  },
  "Objects_54": {
    "additionalProperties": false,
    "properties": {
      "completed": {
        "$ref": "#/components/schemas/Money_2"
      },
      "date": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "expectedDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "fulfillments": {
        "items": {
          "$ref": "#/components/schemas/Objects_53"
        },
        "type": "array"
      },
      "plan": {
        "$ref": "#/components/schemas/Objects_51"
      },
      "planId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "remaining": {
        "$ref": "#/components/schemas/Money_2"
      },
      "status": {
        "enum": ["upcoming", "unconfirmed", "partial", "completed", "skipped"],
        "type": "string"
      }
    },
    "required": ["planId", "date", "plan", "expectedDate", "status", "completed", "fulfillments"],
    "type": "object"
  },
  "Objects_62": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/SubscriptionCancellation"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "SubscriptionStatus": {
    "additionalProperties": false,
    "properties": {
      "accessTier": {
        "$ref": "#/components/schemas/AccessTier"
      },
      "paidSubscription": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/PaidSubscription"
          },
          {
            "type": "null"
          }
        ]
      },
      "recentAttempts": {
        "items": {
          "$ref": "#/components/schemas/BillingAttempt"
        },
        "maxItems": 10,
        "type": "array"
      },
      "trialPeriod": {
        "$ref": "#/components/schemas/TrialPeriod"
      }
    },
    "required": ["accessTier", "trialPeriod", "paidSubscription", "recentAttempts"],
    "type": "object"
  },
  "UpgradeDestination": {
    "additionalProperties": false,
    "properties": {
      "url": {
        "type": "string"
      }
    },
    "required": ["url"],
    "type": "object"
  },
  "SubscriptionOffers": {
    "maxItems": 3,
    "minItems": 3,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/Price"
      },
      {
        "$ref": "#/components/schemas/Price"
      },
      {
        "$ref": "#/components/schemas/Price"
      }
    ],
    "type": "array"
  },
  "CreateTransactionInput_1": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "notes": {
        "maxLength": 500,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      }
    },
    "required": ["money", "direction", "occurredAt"],
    "type": "object"
  },
  "Objects_20": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Transaction"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "TransactionId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_28": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "TransactionPresentation": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "createdAt": {
        "$ref": "#/components/schemas/TransactionCreatedAt"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "notes": {
        "maxLength": 500,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      },
      "presentation": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/Objects_21"
          },
          {
            "anyOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "enum": ["visible-member"],
                    "type": "string"
                  }
                },
                "required": ["kind"],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "enum": ["suppressed-member"],
                    "type": "string"
                  },
                  "requestedId": {
                    "$ref": "#/components/schemas/TransactionId"
                  }
                },
                "required": ["kind", "requestedId"],
                "type": "object"
              }
            ]
          }
        ]
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": [
      "id",
      "money",
      "direction",
      "categoryId",
      "occurredAt",
      "createdAt",
      "revision",
      "presentation"
    ],
    "type": "object"
  },
  "TransactionPairInput": {
    "additionalProperties": false,
    "properties": {
      "firstTransactionId": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "secondTransactionId": {
        "$ref": "#/components/schemas/TransactionId"
      }
    },
    "required": ["firstTransactionId", "secondTransactionId"],
    "type": "object"
  },
  "Objects_22": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/TransactionPresentation"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "SourceAttestation": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/SourceAttestationId"
          },
          "interpretationRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "kind": {
            "enum": ["manual"],
            "type": "string"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "reviewItemId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
            "type": "string"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "sourceProvider": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "$ref": "#/components/schemas/TransactionId"
          },
          "userProvidedFields": {
            "items": {
              "enum": ["money", "direction", "counterparty", "occurredAt", "categoryId"],
              "type": "string"
            },
            "type": "array"
          }
        },
        "required": [
          "id",
          "transactionId",
          "serviceMarket",
          "locale",
          "timeZone",
          "interpretationRevision",
          "createdAt",
          "kind"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "id": {
            "$ref": "#/components/schemas/SourceAttestationId"
          },
          "interpretationRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "kind": {
            "enum": ["statement-line"],
            "type": "string"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "statementContentHash": {
            "minLength": 1,
            "type": "string"
          },
          "statementRecordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "statementSubmissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "$ref": "#/components/schemas/TransactionId"
          }
        },
        "required": [
          "id",
          "transactionId",
          "serviceMarket",
          "locale",
          "timeZone",
          "interpretationRevision",
          "createdAt",
          "kind",
          "statementSubmissionId",
          "statementRecordNumber",
          "statementContentHash",
          "sourceFormat",
          "extractorRevision"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "deterministicInterpretation": {
            "$ref": "#/components/schemas/NotificationInterpretationEvidence"
          },
          "extractorRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "id": {
            "$ref": "#/components/schemas/SourceAttestationId"
          },
          "interpretationRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "kind": {
            "enum": ["notification-email"],
            "type": "string"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "messageContentSha256": {
            "pattern": "^[0-9a-f]{64}$",
            "type": "string"
          },
          "messageEvidence": {
            "$ref": "#/components/schemas/ProviderMessageEvidence"
          },
          "receivedEmailId": {
            "maxLength": 256,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "sourceFormat": {
            "enum": ["notification-email"],
            "type": "string"
          },
          "sourceProvider": {
            "maxLength": 80,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "$ref": "#/components/schemas/TransactionId"
          }
        },
        "required": [
          "id",
          "transactionId",
          "serviceMarket",
          "locale",
          "timeZone",
          "interpretationRevision",
          "createdAt",
          "kind",
          "receivedEmailId",
          "messageEvidence",
          "messageContentSha256",
          "sourceFormat",
          "extractorRevision"
        ],
        "type": "object"
      }
    ]
  },
  "UtcTimestamp": {
    "format": "date-time",
    "pattern": "^(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$",
    "type": "string"
  },
  "Union_2": {
    "description": "Which way the money moved, seen from the user: `outflow` is money leaving them, `inflow` is money reaching them. The amount is unsigned, so this is the only field that carries the sign.",
    "enum": ["inflow", "outflow"],
    "type": "string"
  },
  "Transaction": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "createdAt": {
        "$ref": "#/components/schemas/TransactionCreatedAt"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "notes": {
        "maxLength": 500,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": ["id", "money", "direction", "categoryId", "occurredAt", "createdAt", "revision"],
    "type": "object"
  },
  "Objects_23": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/RestoredTransactionPair"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "UpdateTransactionInput": {
    "additionalProperties": false,
    "properties": {
      "changes": {
        "additionalProperties": false,
        "properties": {
          "categoryId": {
            "$ref": "#/components/schemas/CategoryId"
          },
          "counterparty": {
            "anyOf": [
              {
                "maxLength": 120,
                "minLength": 1,
                "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "direction": {
            "$ref": "#/components/schemas/Union_2"
          },
          "money": {
            "$ref": "#/components/schemas/Money_2"
          },
          "notes": {
            "anyOf": [
              {
                "maxLength": 500,
                "minLength": 1,
                "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "occurredAt": {
            "$ref": "#/components/schemas/TransactionOccurredAt"
          }
        },
        "type": "object"
      },
      "expectedRevision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": ["expectedRevision", "changes"],
    "type": "object"
  },
  "Objects_26": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/Transaction"
      },
      "next": {
        "$ref": "#/components/schemas/Arrays_"
      }
    },
    "required": ["data", "next"],
    "type": "object"
  },
  "FieldIssue": {
    "additionalProperties": false,
    "properties": {
      "message": {
        "description": "What that value should have been, phrased so you can correct it and retry.",
        "type": "string"
      },
      "path": {
        "description": "Dotted path to the value at fault inside what you sent — `amount`, or `items.0.counterparty`. Present when the failure could be pinned to one value; absent when it could not, and then `message` is about the request as a whole.",
        "minLength": 1,
        "type": "string"
      }
    },
    "required": ["message"],
    "type": "object"
  },
  "SuggestedOperation": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["identity.getCurrentUser"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/UserPreferencesPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["identity.updateUserPreferences"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["categories.listCategories"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["categories.listKeywordRules"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateKeywordRuleInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["categories.createKeywordRule"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/KeywordRuleId"
                  }
                },
                "type": "object"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateKeywordRuleInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["categories.updateKeywordRule"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/KeywordRuleId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["categories.deleteKeywordRule"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateBudgetInput"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.createBudget"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.listBudgets"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/BudgetId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.getBudget"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/BudgetId"
                  }
                },
                "type": "object"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateBudgetInput"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.updateBudget"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/BudgetId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.deleteBudget"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "categoryId": {
                    "$ref": "#/components/schemas/CategoryId"
                  },
                  "currency": {
                    "$ref": "#/components/schemas/CurrencyPartial_1"
                  },
                  "month": {
                    "type": "string"
                  },
                  "timeZone": {
                    "$ref": "#/components/schemas/IanaTimeZone"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["budgets.getBudgetStatus"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["connections.listInstitutions"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/ConnectInstitutionInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["connections.connectInstitution"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["connections.listConnections"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/ConnectionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["connections.getConnection"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/ConnectionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["connections.listAccounts"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["dashboard.initializeDashboard"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["dashboard.getDashboard"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["dashboard.getDashboardView"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["dashboard.listDashboardCatalog"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/DashboardEditPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["dashboard.applyDashboardEdit"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/CreateTransactionInput"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.createTransaction"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "categoryId": {
                    "$ref": "#/components/schemas/CategoryId"
                  },
                  "counterparty": {
                    "maxLength": 120,
                    "minLength": 1,
                    "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
                    "type": "string"
                  },
                  "currency": {
                    "$ref": "#/components/schemas/CurrencyPartial_1"
                  },
                  "cursor": {
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|[0-9a-f-]{36}$",
                    "type": "string"
                  },
                  "direction": {
                    "description": "Which way the money moved, seen from the user: `outflow` is money leaving them, `inflow` is money reaching them. The amount is unsigned, so this is the only field that carries the sign.",
                    "enum": ["inflow", "outflow"],
                    "type": "string"
                  },
                  "from": {
                    "$ref": "#/components/schemas/UtcTimestamp"
                  },
                  "to": {
                    "$ref": "#/components/schemas/UtcTimestamp"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.listTransactions"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "cursor": {
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|[0-9a-f-]{36}$",
                    "type": "string"
                  },
                  "q": {
                    "maxLength": 80,
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.searchTransactions"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/TransactionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.getTransaction"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/TransactionPairInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.linkTransactions"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/TransactionPairInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.unlinkTransactions"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/TransactionId"
                  }
                },
                "type": "object"
              },
              "payload": {
                "$ref": "#/components/schemas/UpdateTransactionInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.updateTransaction"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/TransactionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.deleteTransaction"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/TransactionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["transactions.listSourceAttestations"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/NeedsReviewItemId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.getReviewItem"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "anyOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "_tag": {
                        "enum": ["Create"],
                        "type": "string"
                      },
                      "categoryId": {
                        "$ref": "#/components/schemas/CategoryId"
                      },
                      "extraction": {
                        "$ref": "#/components/schemas/TransactionExtraction"
                      },
                      "id": {
                        "$ref": "#/components/schemas/NeedsReviewItemId"
                      },
                      "revision": {
                        "maximum": 9007199254740991,
                        "minimum": 0,
                        "type": "integer"
                      }
                    },
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "_tag": {
                        "enum": ["SaveDraft"],
                        "type": "string"
                      },
                      "draft": {
                        "additionalProperties": false,
                        "properties": {
                          "amount": {
                            "maxLength": 120,
                            "type": "string"
                          },
                          "categoryId": {
                            "$ref": "#/components/schemas/CategoryId"
                          },
                          "counterparty": {
                            "maxLength": 120,
                            "type": "string"
                          },
                          "currency": {
                            "$ref": "#/components/schemas/Currency"
                          },
                          "direction": {
                            "$ref": "#/components/schemas/Union_2"
                          },
                          "occurredAt": {
                            "maxLength": 120,
                            "type": "string"
                          },
                          "userProvidedFields": {
                            "items": {
                              "enum": [
                                "money",
                                "direction",
                                "counterparty",
                                "occurredAt",
                                "categoryId"
                              ],
                              "type": "string"
                            },
                            "maxItems": 5,
                            "type": "array"
                          }
                        },
                        "type": "object"
                      },
                      "id": {
                        "$ref": "#/components/schemas/NeedsReviewItemId"
                      },
                      "revision": {
                        "maximum": 9007199254740991,
                        "minimum": 0,
                        "type": "integer"
                      }
                    },
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "_tag": {
                        "enum": ["Skip"],
                        "type": "string"
                      },
                      "items": {
                        "$ref": "#/components/schemas/Arrays_2"
                      }
                    },
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "_tag": {
                        "enum": ["Restore"],
                        "type": "string"
                      },
                      "items": {
                        "$ref": "#/components/schemas/Arrays_2"
                      }
                    },
                    "type": "object"
                  }
                ]
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.applyReviewEdit"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "offset": {
                    "pattern": "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$",
                    "type": "string"
                  },
                  "status": {
                    "$ref": "#/components/schemas/Union_3"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.getReviewWorkspace"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.enableEmailForwarding"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.getEmailForwarding"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/StatementSubmissionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.getStatementSubmission"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "limit": {
                    "pattern": "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$",
                    "type": "string"
                  },
                  "offset": {
                    "pattern": "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$",
                    "type": "string"
                  },
                  "status": {
                    "$ref": "#/components/schemas/Union_4"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.listNeedsReviewItems"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/NeedsReviewItemId"
                  }
                },
                "type": "object"
              },
              "payload": {
                "$ref": "#/components/schemas/ResolveNeedsReviewItemInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.resolveNeedsReviewItem"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/NeedsReviewItemId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.skipNeedsReviewItem"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/StatementSubmissionId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["ingestion.abandonStatementSubmission"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/InsightEventId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.getRecurringDigestReport"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.getReminderSchedule"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/ReminderScheduleEditPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.updateReminderSchedule"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "cursor": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.listPendingInsights"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_1"
              },
              "payload": {
                "$ref": "#/components/schemas/DeliveryEvidenceInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.markInsightDelivered"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_1"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.markInsightRead"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "$ref": "#/components/schemas/Objects_1"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["insights.dismissInsight"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "cursor": {
                    "maxLength": 1024,
                    "type": "string"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["recurring.listRecurringSeries"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "query": {
                "additionalProperties": false,
                "properties": {
                  "accountId": {
                    "type": "string"
                  },
                  "categoryId": {
                    "type": "string"
                  },
                  "currency": {
                    "$ref": "#/components/schemas/CurrencyPartial_1"
                  },
                  "frequency": {
                    "enum": [
                      "weekly",
                      "fortnightly",
                      "twice-monthly",
                      "monthly",
                      "quarterly",
                      "half-yearly",
                      "yearly"
                    ],
                    "type": "string"
                  },
                  "kind": {
                    "enum": ["income", "expense", "transfer"],
                    "type": "string"
                  },
                  "month": {
                    "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
                    "type": "string"
                  },
                  "previousMonth": {
                    "pattern": "^20\\d{2}-(0[1-9]|1[0-2])$",
                    "type": "string"
                  },
                  "search": {
                    "maxLength": 120,
                    "type": "string"
                  },
                  "status": {
                    "enum": ["upcoming", "unconfirmed", "partial", "completed", "skipped"],
                    "type": "string"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["recurringPlans.getRecurringWorkspace"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "additionalProperties": false,
                "properties": {
                  "edit": {
                    "anyOf": [
                      {
                        "additionalProperties": false,
                        "properties": {
                          "id": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["create"],
                            "type": "string"
                          },
                          "plan": {
                            "$ref": "#/components/schemas/Objects_2"
                          },
                          "seriesId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "date": {
                            "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["edit"],
                            "type": "string"
                          },
                          "plan": {
                            "$ref": "#/components/schemas/Objects_2"
                          },
                          "planId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "scope": {
                            "enum": ["once", "forward"],
                            "type": "string"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "action": {
                            "enum": ["pause", "resume", "stop"],
                            "type": "string"
                          },
                          "date": {
                            "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["lifecycle"],
                            "type": "string"
                          },
                          "planId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "date": {
                            "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["skip"],
                            "type": "string"
                          },
                          "planId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "skipped": {
                            "type": "boolean"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "fulfillment": {
                            "additionalProperties": false,
                            "properties": {
                              "actualDate": {
                                "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                                "type": "string"
                              },
                              "automatic": {
                                "type": "boolean"
                              },
                              "date": {
                                "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
                                "type": "string"
                              },
                              "id": {
                                "format": "uuid",
                                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                                "type": "string"
                              },
                              "money": {
                                "additionalProperties": false,
                                "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
                                "properties": {
                                  "amount": {
                                    "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
                                    "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
                                    "type": "string"
                                  },
                                  "currency": {
                                    "$ref": "#/components/schemas/CurrencyPartial"
                                  }
                                },
                                "type": "object"
                              },
                              "planId": {
                                "format": "uuid",
                                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                                "type": "string"
                              },
                              "settled": {
                                "type": "boolean"
                              },
                              "transactionId": {
                                "format": "uuid",
                                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                                "type": "string"
                              }
                            },
                            "type": "object"
                          },
                          "kind": {
                            "enum": ["fulfill"],
                            "type": "string"
                          },
                          "replaces": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "fulfillmentId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["reverse"],
                            "type": "string"
                          }
                        },
                        "type": "object"
                      },
                      {
                        "additionalProperties": false,
                        "properties": {
                          "action": {
                            "enum": ["dismiss", "restore", "link"],
                            "type": "string"
                          },
                          "kind": {
                            "enum": ["suggestion"],
                            "type": "string"
                          },
                          "planId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          },
                          "seriesId": {
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
                            "type": "string"
                          }
                        },
                        "type": "object"
                      }
                    ]
                  },
                  "expectedRevision": {
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
                    "type": "integer"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["recurringPlans.applyRecurringEdit"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "payload": {
                "$ref": "#/components/schemas/RememberInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["memory.remember"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/MemoryId"
                  }
                },
                "type": "object"
              },
              "payload": {
                "$ref": "#/components/schemas/ReviseInputPartial"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["memory.revise"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "args": {
            "additionalProperties": false,
            "description": "Arguments already worked out for that call. Partial by design: merge them into the operation's own input rather than sending them as the whole of it.",
            "properties": {
              "params": {
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "$ref": "#/components/schemas/MemoryId"
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["memory.forget"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["memory.recall"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["subscription.getUpgradeUrl"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["subscription.listSubscriptionOffers"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["subscription.getSubscriptionStatus"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["subscription.cancelSubscription"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "hint": {
            "maxLength": 140,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "tool": {
            "description": "The canonical operation to call, spelled exactly as its `operationId` in this spec. Look that id up here to see the complete input and result.",
            "enum": ["quota.getQuota"],
            "type": "string"
          }
        },
        "required": ["tool", "hint"],
        "type": "object"
      }
    ]
  },
  "AppliedBudgetMonth": {
    "additionalProperties": false,
    "properties": {
      "from": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "to": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["from", "to", "timeZone"],
    "type": "object"
  },
  "BudgetStatus": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "budget": {
            "$ref": "#/components/schemas/Budget"
          },
          "period": {
            "$ref": "#/components/schemas/AppliedBudgetMonth"
          },
          "remaining": {
            "$ref": "#/components/schemas/Money_2"
          },
          "spent": {
            "$ref": "#/components/schemas/Money_2"
          },
          "type": {
            "enum": ["under"],
            "type": "string"
          }
        },
        "required": ["budget", "spent", "period", "type", "remaining"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "budget": {
            "$ref": "#/components/schemas/Budget"
          },
          "period": {
            "$ref": "#/components/schemas/AppliedBudgetMonth"
          },
          "spent": {
            "$ref": "#/components/schemas/Money_2"
          },
          "type": {
            "enum": ["reached"],
            "type": "string"
          }
        },
        "required": ["budget", "spent", "period", "type"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "budget": {
            "$ref": "#/components/schemas/Budget"
          },
          "overBy": {
            "$ref": "#/components/schemas/Money_2"
          },
          "period": {
            "$ref": "#/components/schemas/AppliedBudgetMonth"
          },
          "spent": {
            "$ref": "#/components/schemas/Money_2"
          },
          "type": {
            "enum": ["over"],
            "type": "string"
          }
        },
        "required": ["budget", "spent", "period", "type", "overBy"],
        "type": "object"
      }
    ]
  },
  "CategoryKeyword": {
    "maxLength": 80,
    "minLength": 1,
    "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
    "type": "string"
  },
  "CategoryLabel": {
    "maxLength": 80,
    "minLength": 1,
    "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
    "type": "string"
  },
  "InstitutionId": {
    "minLength": 1,
    "pattern": "^[a-z][a-z0-9-]{0,63}$",
    "type": "string"
  },
  "ConnectInstitutionResult": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "connection": {
            "additionalProperties": false,
            "properties": {
              "id": {
                "$ref": "#/components/schemas/ConnectionId"
              },
              "institutionId": {
                "$ref": "#/components/schemas/InstitutionId"
              },
              "state": {
                "enum": ["Connecting"],
                "type": "string"
              }
            },
            "required": ["id", "institutionId", "state"],
            "type": "object"
          },
          "continuation": {
            "$ref": "#/components/schemas/BrowserContinuation"
          },
          "type": {
            "enum": ["continue_in_browser"],
            "type": "string"
          }
        },
        "required": ["type", "connection", "continuation"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "connection": {
            "additionalProperties": false,
            "properties": {
              "id": {
                "$ref": "#/components/schemas/ConnectionId"
              },
              "institutionId": {
                "$ref": "#/components/schemas/InstitutionId"
              },
              "state": {
                "enum": ["Active"],
                "type": "string"
              }
            },
            "required": ["id", "institutionId", "state"],
            "type": "object"
          },
          "type": {
            "enum": ["already_connected"],
            "type": "string"
          }
        },
        "required": ["type", "connection"],
        "type": "object"
      }
    ]
  },
  "ConnectionState": {
    "enum": ["Connecting", "Active", "Action required", "Ended"],
    "type": "string"
  },
  "AccountId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "SetTitle": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["set-title"],
        "type": "string"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      }
    },
    "required": ["op", "title"],
    "type": "object"
  },
  "AddWidget": {
    "additionalProperties": false,
    "properties": {
      "at": {
        "$ref": "#/components/schemas/Union_9"
      },
      "op": {
        "enum": ["add-widget"],
        "type": "string"
      },
      "widget": {
        "$ref": "#/components/schemas/Widget"
      }
    },
    "required": ["op", "widget", "at"],
    "type": "object"
  },
  "RemoveWidget": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["remove-widget"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "required": ["op", "widgetId"],
    "type": "object"
  },
  "MoveWidget": {
    "additionalProperties": false,
    "properties": {
      "at": {
        "$ref": "#/components/schemas/Union_9"
      },
      "op": {
        "enum": ["move-widget"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "required": ["op", "widgetId", "at"],
    "type": "object"
  },
  "SwapWidgets": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["swap-widgets"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "withWidgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "required": ["op", "widgetId", "withWidgetId"],
    "type": "object"
  },
  "ResizeRegion": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["resize-region"],
        "type": "string"
      },
      "size": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["weight"],
                "type": "string"
              },
              "weight": {
                "$ref": "#/components/schemas/SplitWeight"
              }
            },
            "required": ["kind", "weight"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["ratio"],
                "type": "string"
              },
              "ratio": {
                "enum": ["one-quarter", "one-third", "one-half", "two-thirds", "three-quarters"],
                "type": "string"
              }
            },
            "required": ["kind", "ratio"],
            "type": "object"
          }
        ]
      },
      "widgetIds": {
        "$ref": "#/components/schemas/LayoutRegionSelector_1"
      }
    },
    "required": ["op", "widgetIds", "size"],
    "type": "object"
  },
  "UpdateWidget": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["update-widget"],
        "type": "string"
      },
      "widget": {
        "$ref": "#/components/schemas/Widget"
      }
    },
    "required": ["op", "widget"],
    "type": "object"
  },
  "LayoutNode": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["leaf"],
            "type": "string"
          },
          "widget": {
            "$ref": "#/components/schemas/Widget"
          }
        },
        "required": ["kind", "widget"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "axis": {
            "$ref": "#/components/schemas/Union_8"
          },
          "children": {
            "items": {
              "$ref": "#/components/schemas/Objects_16"
            },
            "maxItems": 24,
            "minItems": 2,
            "prefixItems": [
              {
                "$ref": "#/components/schemas/Objects_16"
              },
              {
                "$ref": "#/components/schemas/Objects_16"
              }
            ],
            "type": "array"
          },
          "kind": {
            "enum": ["split"],
            "type": "string"
          }
        },
        "required": ["kind", "axis", "children"],
        "type": "object"
      }
    ]
  },
  "DashboardViewContext": {
    "additionalProperties": false,
    "properties": {
      "calculatedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "required": ["serviceMarket", "locale", "timeZone", "calculatedAt"],
    "type": "object"
  },
  "DashboardViewLayout": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["leaf"],
            "type": "string"
          },
          "widget": {
            "$ref": "#/components/schemas/DashboardWidgetView"
          }
        },
        "required": ["kind", "widget"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "axis": {
            "$ref": "#/components/schemas/Union_8"
          },
          "children": {
            "items": {
              "$ref": "#/components/schemas/Objects_17"
            },
            "maxItems": 24,
            "minItems": 2,
            "prefixItems": [
              {
                "$ref": "#/components/schemas/Objects_17"
              },
              {
                "$ref": "#/components/schemas/Objects_17"
              }
            ],
            "type": "array"
          },
          "kind": {
            "enum": ["split"],
            "type": "string"
          }
        },
        "required": ["kind", "axis", "children"],
        "type": "object"
      }
    ]
  },
  "WidgetTemplate": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/SpendingChartTemplate"
      },
      {
        "$ref": "#/components/schemas/BudgetBarTemplate"
      },
      {
        "$ref": "#/components/schemas/TransactionListTemplate"
      },
      {
        "$ref": "#/components/schemas/CustomMetricTemplate"
      }
    ]
  },
  "UserId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Locale": {
    "enum": ["es-CO"],
    "type": "string"
  },
  "ServiceMarket": {
    "enum": ["CO"],
    "type": "string"
  },
  "TrialPeriod": {
    "additionalProperties": false,
    "properties": {
      "endsAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "startedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["startedAt", "endsAt"],
    "type": "object"
  },
  "TransactionExtraction_1": {
    "additionalProperties": false,
    "properties": {
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      }
    },
    "required": ["money", "direction", "occurredAt"],
    "type": "object"
  },
  "Objects_31": {
    "additionalProperties": false,
    "properties": {
      "amount": {
        "maxLength": 120,
        "type": "string"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "maxLength": 120,
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "occurredAt": {
        "maxLength": 120,
        "type": "string"
      },
      "userProvidedFields": {
        "items": {
          "enum": ["money", "direction", "counterparty", "occurredAt", "categoryId"],
          "type": "string"
        },
        "maxItems": 5,
        "type": "array"
      }
    },
    "required": ["amount", "counterparty", "occurredAt", "userProvidedFields"],
    "type": "object"
  },
  "Arrays_4": {
    "items": {
      "$ref": "#/components/schemas/Objects_32"
    },
    "maxItems": 100,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/Objects_32"
      }
    ],
    "type": "array"
  },
  "EmailForwardingAddress": {
    "additionalProperties": false,
    "properties": {
      "address": {
        "maxLength": 320,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "$ref": "#/components/schemas/EmailForwardingAddressId"
      }
    },
    "required": ["id", "address", "createdAt"],
    "type": "object"
  },
  "Objects_30": {
    "additionalProperties": false,
    "properties": {
      "amount": {
        "maxLength": 120,
        "type": "string"
      },
      "counterparty": {
        "maxLength": 120,
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      }
    },
    "required": ["counterparty", "amount"],
    "type": "object"
  },
  "Union_12": {
    "enum": ["statement", "email", "media"],
    "type": "string"
  },
  "Union_10": {
    "enum": ["csv", "xlsx"],
    "type": "string"
  },
  "StatementAccounting": {
    "additionalProperties": false,
    "properties": {
      "abandonedRows": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "acceptedRows": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "inputRows": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "needsReviewRows": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "skippedRows": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": ["inputRows", "acceptedRows", "needsReviewRows"],
    "type": "object"
  },
  "StatementNeedsReviewItem": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "minLength": 1,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_5"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_14"
          },
          "recordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["statement-upload"],
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": ["skipped"],
            "type": "string"
          },
          "submissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "submissionId",
          "recordNumber",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "minLength": 1,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_5"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_14"
          },
          "recordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["statement-upload"],
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": ["abandoned"],
            "type": "string"
          },
          "submissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "submissionId",
          "recordNumber",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "minLength": 1,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_5"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "originalEvidence": {
            "anyOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "endLine": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  },
                  "fields": {
                    "items": {
                      "type": "string"
                    },
                    "type": "array"
                  },
                  "rawRecord": {
                    "type": "string"
                  },
                  "recordNumber": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  },
                  "sourceFormat": {
                    "enum": ["csv"],
                    "type": "string"
                  },
                  "startLine": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  }
                },
                "required": [
                  "sourceFormat",
                  "recordNumber",
                  "startLine",
                  "endLine",
                  "rawRecord",
                  "fields"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "cells": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "address": {
                          "minLength": 1,
                          "type": "string"
                        },
                        "cellType": {
                          "enum": ["blank", "string", "number", "date", "boolean", "error"],
                          "type": "string"
                        },
                        "formattedText": {
                          "type": "string"
                        },
                        "formula": {
                          "type": "string"
                        },
                        "numberFormat": {
                          "type": "string"
                        },
                        "value": {
                          "type": "string"
                        }
                      },
                      "required": ["address", "cellType", "value"],
                      "type": "object"
                    },
                    "type": "array"
                  },
                  "hidden": {
                    "type": "boolean"
                  },
                  "rowNumber": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  },
                  "sheetIndex": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "sheetName": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "sourceFormat": {
                    "enum": ["xlsx"],
                    "type": "string"
                  }
                },
                "required": [
                  "sourceFormat",
                  "sheetName",
                  "sheetIndex",
                  "rowNumber",
                  "hidden",
                  "cells"
                ],
                "type": "object"
              }
            ]
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_14"
          },
          "recordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["statement-upload"],
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": ["pending"],
            "type": "string"
          },
          "submissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "submissionId",
          "recordNumber",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "minLength": 1,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_5"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_14"
          },
          "recordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["statement-upload"],
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": ["expired"],
            "type": "string"
          },
          "submissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "submissionId",
          "recordNumber",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "minLength": 1,
            "type": "string"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_5"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "parserRevision": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_14"
          },
          "recordNumber": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "resolvedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["statement-upload"],
            "type": "string"
          },
          "sourceFormat": {
            "$ref": "#/components/schemas/Union_10"
          },
          "sourceProvider": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": ["resolved"],
            "type": "string"
          },
          "submissionId": {
            "$ref": "#/components/schemas/StatementSubmissionId"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          },
          "transactionId": {
            "$ref": "#/components/schemas/TransactionId"
          }
        },
        "required": [
          "id",
          "submissionId",
          "recordNumber",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status",
          "transactionId",
          "resolvedAt"
        ],
        "type": "object"
      }
    ]
  },
  "EmailNeedsReviewItem": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "ingestSampleId": {
            "$ref": "#/components/schemas/IngestSampleId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_6"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "messageEvidence": {
            "$ref": "#/components/schemas/ProviderMessageEvidence"
          },
          "parserRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "reason": {
            "enum": [
              "canonical-validation-failed",
              "unsupported-content",
              "unknown-format",
              "ambiguous-format",
              "invalid-format"
            ],
            "type": "string"
          },
          "receivedEmailId": {
            "maxLength": 256,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["forwarded-email"],
            "type": "string"
          },
          "sourceFormat": {
            "enum": ["notification-email"],
            "type": "string"
          },
          "sourceProvider": {
            "enum": ["cloudflare-email"],
            "type": "string"
          },
          "status": {
            "enum": ["pending"],
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "receivedEmailId",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "sourceProvider",
          "messageEvidence",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "ingestSampleId",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_6"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "messageEvidence": {
            "$ref": "#/components/schemas/ProviderMessageEvidence"
          },
          "parserRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "reason": {
            "$ref": "#/components/schemas/Union_15"
          },
          "receivedEmailId": {
            "maxLength": 256,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["forwarded-email"],
            "type": "string"
          },
          "sourceFormat": {
            "enum": ["notification-email"],
            "type": "string"
          },
          "sourceProvider": {
            "enum": ["cloudflare-email"],
            "type": "string"
          },
          "status": {
            "enum": ["pending"],
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "receivedEmailId",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "sourceProvider",
          "messageEvidence",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "extractorRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "id": {
            "$ref": "#/components/schemas/NeedsReviewItemId"
          },
          "issues": {
            "$ref": "#/components/schemas/Arrays_6"
          },
          "knownMoney": {
            "$ref": "#/components/schemas/Money_2"
          },
          "locale": {
            "$ref": "#/components/schemas/Locale"
          },
          "messageEvidence": {
            "$ref": "#/components/schemas/ProviderMessageEvidence"
          },
          "parserRevision": {
            "$ref": "#/components/schemas/InterpretationRevision"
          },
          "reason": {
            "anyOf": [
              {
                "enum": [
                  "canonical-validation-failed",
                  "unsupported-content",
                  "unknown-format",
                  "ambiguous-format",
                  "invalid-format"
                ],
                "type": "string"
              },
              {
                "$ref": "#/components/schemas/Union_15"
              }
            ]
          },
          "receivedEmailId": {
            "maxLength": 256,
            "minLength": 1,
            "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
            "type": "string"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "sourceChannel": {
            "enum": ["forwarded-email"],
            "type": "string"
          },
          "sourceFormat": {
            "enum": ["notification-email"],
            "type": "string"
          },
          "sourceProvider": {
            "enum": ["cloudflare-email"],
            "type": "string"
          },
          "status": {
            "enum": ["expired"],
            "type": "string"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "id",
          "receivedEmailId",
          "reason",
          "serviceMarket",
          "locale",
          "timeZone",
          "sourceFormat",
          "sourceChannel",
          "sourceProvider",
          "messageEvidence",
          "parserRevision",
          "extractorRevision",
          "issues",
          "createdAt",
          "status"
        ],
        "type": "object"
      }
    ]
  },
  "MediaNeedsReviewItem": {
    "additionalProperties": false,
    "properties": {
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "$ref": "#/components/schemas/NeedsReviewItemId"
      },
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "mediaSubmissionId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "reason": {
        "enum": ["extraction-unavailable", "unparseable-material"],
        "type": "string"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "sourceChannel": {
        "enum": ["whatsapp"],
        "type": "string"
      },
      "sourceFormat": {
        "enum": ["image"],
        "type": "string"
      },
      "status": {
        "enum": ["pending", "expired"],
        "type": "string"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "required": [
      "id",
      "mediaSubmissionId",
      "reason",
      "serviceMarket",
      "locale",
      "timeZone",
      "sourceChannel",
      "sourceFormat",
      "status",
      "createdAt"
    ],
    "type": "object"
  },
  "RecurringDigestPayload": {
    "additionalProperties": false,
    "properties": {
      "confirmationDay": {
        "$ref": "#/components/schemas/ConfirmationDay"
      },
      "items": {
        "items": {
          "$ref": "#/components/schemas/RecurringDigestItem"
        },
        "minItems": 1,
        "prefixItems": [
          {
            "$ref": "#/components/schemas/RecurringDigestItem"
          }
        ],
        "type": "array"
      }
    },
    "required": ["confirmationDay", "items"],
    "type": "object"
  },
  "ReminderCadence": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["daily"],
            "type": "string"
          }
        },
        "required": ["kind"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["weekdays"],
            "type": "string"
          }
        },
        "required": ["kind"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "anchorDate": {
            "$ref": "#/components/schemas/ReminderAnchorDate"
          },
          "kind": {
            "enum": ["every-three-days"],
            "type": "string"
          }
        },
        "required": ["kind", "anchorDate"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["weekly"],
            "type": "string"
          },
          "weekday": {
            "maximum": 6,
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["kind", "weekday"],
        "type": "object"
      }
    ]
  },
  "ScheduleId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "ReminderTiming": {
    "additionalProperties": false,
    "properties": {
      "hour": {
        "maximum": 23,
        "minimum": 0,
        "type": "integer"
      },
      "minute": {
        "maximum": 59,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": ["hour", "minute"],
    "type": "object"
  },
  "ScheduleVersion": {
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991,
    "type": "integer"
  },
  "MoneyGroups": {
    "items": {
      "$ref": "#/components/schemas/MoneyGroup"
    },
    "type": "array"
  },
  "InsightDeliveryAttempt": {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "maxLength": 32,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "id": {
        "$ref": "#/components/schemas/DeliveryAttemptId"
      },
      "insightEventId": {
        "$ref": "#/components/schemas/InsightEventId"
      },
      "provider": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "providerMessageId": {
        "maxLength": 256,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "sentAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["id", "insightEventId", "sentAt", "channel", "provider", "providerMessageId"],
    "type": "object"
  },
  "Memory": {
    "additionalProperties": false,
    "properties": {
      "createdAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "$ref": "#/components/schemas/MemoryId"
      },
      "text": {
        "$ref": "#/components/schemas/MemoryText"
      },
      "updatedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["id", "text", "createdAt", "updatedAt"],
    "type": "object"
  },
  "MemoryTextEncoded": {
    "type": "string"
  },
  "AtomicBatchCallId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Objects_5": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/KeywordRuleId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_7": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/KeywordRuleId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_10": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/BudgetId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_12": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/BudgetId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_25": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_27": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_36": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/NeedsReviewItemId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_38": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/NeedsReviewItemId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_40": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/StatementSubmissionId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_45": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/InsightEventId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_58": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/MemoryId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "Objects_60": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/MemoryId"
      }
    },
    "required": ["id"],
    "type": "object"
  },
  "CanonicalOperationId": {
    "pattern": "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$",
    "type": "string"
  },
  "RecurringSeries": {
    "additionalProperties": false,
    "properties": {
      "announcement": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["eligible"],
                "type": "string"
              }
            },
            "required": ["kind"],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["suppressed"],
                "type": "string"
              },
              "reason": {
                "enum": ["backfill", "cold-start"],
                "type": "string"
              }
            },
            "required": ["kind", "reason"],
            "type": "object"
          }
        ]
      },
      "cadence": {
        "$ref": "#/components/schemas/Objects_43"
      },
      "confirmedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "counterparty": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "firstOccurredAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "id": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "lastOccurredAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "money": {
        "$ref": "#/components/schemas/Objects_42"
      }
    },
    "required": [
      "id",
      "counterparty",
      "money",
      "cadence",
      "firstOccurredAt",
      "lastOccurredAt",
      "confirmedAt",
      "announcement"
    ],
    "type": "object"
  },
  "Objects_51": {
    "additionalProperties": false,
    "properties": {
      "accountId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "amountMode": {
        "enum": ["fixed", "estimated", "unknown"],
        "type": "string"
      },
      "cardPayment": {
        "type": "boolean"
      },
      "categoryId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "counterparty": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      },
      "endDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "firstDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "frequency": {
        "$ref": "#/components/schemas/Union_17"
      },
      "kind": {
        "$ref": "#/components/schemas/Union_16"
      },
      "money": {
        "$ref": "#/components/schemas/Objects_52"
      },
      "monthDays": {
        "maxItems": 2,
        "minItems": 2,
        "prefixItems": [
          {
            "anyOf": [
              {
                "maximum": 31,
                "minimum": 1,
                "type": "integer"
              },
              {
                "enum": ["last"],
                "type": "string"
              }
            ]
          },
          {
            "anyOf": [
              {
                "maximum": 31,
                "minimum": 1,
                "type": "integer"
              },
              {
                "enum": ["last"],
                "type": "string"
              }
            ]
          }
        ],
        "type": "array"
      },
      "name": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "required": ["name", "kind", "currency", "amountMode", "frequency", "firstDate", "timeZone"],
    "type": "object"
  },
  "Objects_53": {
    "additionalProperties": false,
    "properties": {
      "actualDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "automatic": {
        "type": "boolean"
      },
      "date": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "id": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "money": {
        "$ref": "#/components/schemas/Objects_52"
      },
      "planId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "settled": {
        "type": "boolean"
      },
      "transactionId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      }
    },
    "required": ["id", "planId", "date", "money", "actualDate", "settled"],
    "type": "object"
  },
  "Objects_50": {
    "additionalProperties": false,
    "properties": {
      "from": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "plan": {
        "$ref": "#/components/schemas/Objects_51"
      }
    },
    "required": ["from", "plan"],
    "type": "object"
  },
  "SubscriptionCancellation": {
    "additionalProperties": false,
    "properties": {
      "cancelledAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "paidThrough": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "sourceCancellation": {
        "enum": ["detached", "void-pending", "voided"],
        "type": "string"
      }
    },
    "required": ["cancelledAt", "paidThrough", "sourceCancellation"],
    "type": "object"
  },
  "PaidSubscription": {
    "additionalProperties": false,
    "properties": {
      "billingPeriod": {
        "$ref": "#/components/schemas/BillingPeriod"
      },
      "endsAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "priceId": {
        "$ref": "#/components/schemas/PriceId"
      },
      "renewalAnchor": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "startsAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "taxTreatment": {
        "$ref": "#/components/schemas/TaxTreatment"
      }
    },
    "required": [
      "priceId",
      "money",
      "billingPeriod",
      "serviceMarket",
      "taxTreatment",
      "startsAt",
      "endsAt",
      "renewalAnchor"
    ],
    "type": "object"
  },
  "BillingAttempt": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "billingPeriod": {
            "$ref": "#/components/schemas/BillingPeriod"
          },
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/BillingAttemptId"
          },
          "money": {
            "$ref": "#/components/schemas/Money_2"
          },
          "priceId": {
            "$ref": "#/components/schemas/PriceId"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "status": {
            "enum": ["pending"],
            "type": "string"
          },
          "taxTreatment": {
            "$ref": "#/components/schemas/TaxTreatment"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "status",
          "id",
          "priceId",
          "money",
          "billingPeriod",
          "serviceMarket",
          "taxTreatment",
          "timeZone",
          "createdAt"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "billingPeriod": {
            "$ref": "#/components/schemas/BillingPeriod"
          },
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "failedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/BillingAttemptId"
          },
          "money": {
            "$ref": "#/components/schemas/Money_2"
          },
          "priceId": {
            "$ref": "#/components/schemas/PriceId"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "status": {
            "enum": ["failed"],
            "type": "string"
          },
          "taxTreatment": {
            "$ref": "#/components/schemas/TaxTreatment"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "status",
          "id",
          "priceId",
          "money",
          "billingPeriod",
          "serviceMarket",
          "taxTreatment",
          "timeZone",
          "createdAt",
          "failedAt"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "billingPeriod": {
            "$ref": "#/components/schemas/BillingPeriod"
          },
          "createdAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "finalizedAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "id": {
            "$ref": "#/components/schemas/BillingAttemptId"
          },
          "money": {
            "$ref": "#/components/schemas/Money_2"
          },
          "paidPeriodEndsAt": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "priceId": {
            "$ref": "#/components/schemas/PriceId"
          },
          "renewalAnchor": {
            "$ref": "#/components/schemas/UtcTimestamp"
          },
          "serviceMarket": {
            "$ref": "#/components/schemas/ServiceMarket"
          },
          "status": {
            "enum": ["succeeded"],
            "type": "string"
          },
          "taxTreatment": {
            "$ref": "#/components/schemas/TaxTreatment"
          },
          "timeZone": {
            "$ref": "#/components/schemas/IanaTimeZone"
          }
        },
        "required": [
          "status",
          "id",
          "priceId",
          "money",
          "billingPeriod",
          "serviceMarket",
          "taxTreatment",
          "timeZone",
          "createdAt",
          "finalizedAt",
          "paidPeriodEndsAt",
          "renewalAnchor"
        ],
        "type": "object"
      }
    ]
  },
  "Price": {
    "additionalProperties": false,
    "properties": {
      "billingPeriod": {
        "$ref": "#/components/schemas/BillingPeriod"
      },
      "id": {
        "$ref": "#/components/schemas/PriceId"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "paymentMethods": {
        "$ref": "#/components/schemas/LaunchPaymentMethods"
      },
      "renewalTerms": {
        "$ref": "#/components/schemas/RenewalTerms"
      },
      "serviceMarket": {
        "$ref": "#/components/schemas/ServiceMarket"
      },
      "taxTreatment": {
        "$ref": "#/components/schemas/TaxTreatment"
      }
    },
    "required": [
      "id",
      "money",
      "billingPeriod",
      "serviceMarket",
      "taxTreatment",
      "renewalTerms",
      "paymentMethods"
    ],
    "type": "object"
  },
  "TransactionOccurredAt": {
    "description": "When the money actually moved. It must already have happened — a Transaction dated in the future is rejected — and the history is ordered by it, so send the instant the user is describing rather than the moment you are recording it.",
    "format": "date-time",
    "pattern": "^(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$",
    "type": "string"
  },
  "TransactionCreatedAt": {
    "description": "When fidy learned of it, which can be long after it occurred: a statement read in July carries movements from March. Reason about the user's spending from `occurredAt`; read this only to tell how freshly the record was captured.",
    "format": "date-time",
    "pattern": "^(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$",
    "type": "string"
  },
  "Objects_21": {
    "additionalProperties": false,
    "properties": {
      "kind": {
        "enum": ["independent"],
        "type": "string"
      }
    },
    "required": ["kind"],
    "type": "object"
  },
  "SourceAttestationId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "InterpretationRevision": {
    "maxLength": 80,
    "minLength": 1,
    "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
    "type": "string"
  },
  "NotificationInterpretationEvidence": {
    "additionalProperties": false,
    "properties": {
      "accountHints": {
        "$ref": "#/components/schemas/AccountHints"
      },
      "currencyBasis": {
        "enum": ["explicit", "format-cop-default-v1"],
        "type": "string"
      },
      "formatId": {
        "$ref": "#/components/schemas/NotificationFormatId"
      }
    },
    "required": ["formatId", "currencyBasis", "accountHints"],
    "type": "object"
  },
  "ProviderMessageEvidence": {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "maxLength": 32,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "provider": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "providerMessageId": {
        "maxLength": 256,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      }
    },
    "required": ["channel", "provider", "providerMessageId"],
    "type": "object"
  },
  "RestoredTransactionPair": {
    "additionalProperties": false,
    "properties": {
      "firstTransaction": {
        "$ref": "#/components/schemas/Objects_24"
      },
      "secondTransaction": {
        "$ref": "#/components/schemas/Objects_24"
      }
    },
    "required": ["firstTransaction", "secondTransaction"],
    "type": "object"
  },
  "UserPreferencesPartial": {
    "additionalProperties": false,
    "properties": {
      "locale": {
        "$ref": "#/components/schemas/Locale"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "type": "object"
  },
  "CreateKeywordRuleInputPartial": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "keyword": {
        "$ref": "#/components/schemas/CategoryKeyword"
      }
    },
    "type": "object"
  },
  "UpdateKeywordRuleInputPartial": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "keyword": {
        "$ref": "#/components/schemas/CategoryKeyword"
      }
    },
    "type": "object"
  },
  "CreateBudgetInput": {
    "additionalProperties": false,
    "properties": {
      "cap": {
        "$ref": "#/components/schemas/Money"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "groupName": {
        "maxLength": 64,
        "minLength": 1,
        "type": "string"
      },
      "month": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "UpdateBudgetInput": {
    "additionalProperties": false,
    "properties": {
      "cap": {
        "$ref": "#/components/schemas/Money"
      },
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "groupCategoryIds": {
        "items": {
          "$ref": "#/components/schemas/CategoryId"
        },
        "maxItems": 128,
        "minItems": 1,
        "type": "array"
      },
      "groupCurrency": {
        "$ref": "#/components/schemas/CurrencyPartial_1"
      },
      "groupName": {
        "maxLength": 64,
        "minLength": 1,
        "type": "string"
      },
      "month": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "CurrencyPartial_1": {
    "description": "A recognized monetary ISO 4217 alphabetic code. It determines the maximum fractional precision of Money and does not imply that fidy operates in that currency's markets.",
    "enum": [
      "AED",
      "AFN",
      "ALL",
      "AMD",
      "AOA",
      "ARS",
      "AUD",
      "AWG",
      "AZN",
      "BAM",
      "BBD",
      "BDT",
      "BHD",
      "BIF",
      "BMD",
      "BND",
      "BOB",
      "BRL",
      "BSD",
      "BTN",
      "BWP",
      "BYN",
      "BZD",
      "CAD",
      "CDF",
      "CHF",
      "CLP",
      "CNY",
      "COP",
      "CRC",
      "CUP",
      "CVE",
      "CZK",
      "DJF",
      "DKK",
      "DOP",
      "DZD",
      "EGP",
      "ERN",
      "ETB",
      "EUR",
      "FJD",
      "FKP",
      "GBP",
      "GEL",
      "GHS",
      "GIP",
      "GMD",
      "GNF",
      "GTQ",
      "GYD",
      "HKD",
      "HNL",
      "HTG",
      "HUF",
      "IDR",
      "ILS",
      "INR",
      "IQD",
      "IRR",
      "ISK",
      "JMD",
      "JOD",
      "JPY",
      "KES",
      "KGS",
      "KHR",
      "KMF",
      "KPW",
      "KRW",
      "KWD",
      "KYD",
      "KZT",
      "LAK",
      "LBP",
      "LKR",
      "LRD",
      "LSL",
      "LYD",
      "MAD",
      "MDL",
      "MGA",
      "MKD",
      "MMK",
      "MNT",
      "MOP",
      "MRU",
      "MUR",
      "MVR",
      "MWK",
      "MXN",
      "MYR",
      "MZN",
      "NAD",
      "NGN",
      "NIO",
      "NOK",
      "NPR",
      "NZD",
      "OMR",
      "PAB",
      "PEN",
      "PGK",
      "PHP",
      "PKR",
      "PLN",
      "PYG",
      "QAR",
      "RON",
      "RSD",
      "RUB",
      "RWF",
      "SAR",
      "SBD",
      "SCR",
      "SDG",
      "SEK",
      "SGD",
      "SHP",
      "SLE",
      "SOS",
      "SRD",
      "SSP",
      "STN",
      "SVC",
      "SYP",
      "SZL",
      "THB",
      "TJS",
      "TMT",
      "TND",
      "TOP",
      "TRY",
      "TTD",
      "TWD",
      "TZS",
      "UAH",
      "UGX",
      "USD",
      "UYU",
      "UYW",
      "UZS",
      "VED",
      "VES",
      "VND",
      "VUV",
      "WST",
      "XAF",
      "XCD",
      "XCG",
      "XOF",
      "XPF",
      "YER",
      "ZAR",
      "ZMW",
      "ZWG"
    ],
    "type": "string"
  },
  "ConnectInstitutionInputPartial": {
    "additionalProperties": false,
    "properties": {
      "institutionId": {
        "$ref": "#/components/schemas/InstitutionId"
      }
    },
    "type": "object"
  },
  "DashboardEditPartial": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/SetTitlePartial"
      },
      {
        "$ref": "#/components/schemas/AddWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/RemoveWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/MoveWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/SwapWidgetsPartial"
      },
      {
        "$ref": "#/components/schemas/ResizeRegionPartial"
      },
      {
        "$ref": "#/components/schemas/UpdateWidgetPartial"
      }
    ]
  },
  "CreateTransactionInput": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "direction": {
        "description": "Which way the money moved, seen from the user: `outflow` is money leaving them, `inflow` is money reaching them. The amount is unsigned, so this is the only field that carries the sign.",
        "enum": ["inflow", "outflow"],
        "type": "string"
      },
      "money": {
        "$ref": "#/components/schemas/Money"
      },
      "notes": {
        "maxLength": 500,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      }
    },
    "type": "object"
  },
  "TransactionPairInputPartial": {
    "additionalProperties": false,
    "properties": {
      "firstTransactionId": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "secondTransactionId": {
        "$ref": "#/components/schemas/TransactionId"
      }
    },
    "type": "object"
  },
  "UpdateTransactionInputPartial": {
    "additionalProperties": false,
    "properties": {
      "changes": {
        "additionalProperties": false,
        "properties": {
          "categoryId": {
            "$ref": "#/components/schemas/CategoryId"
          },
          "counterparty": {
            "anyOf": [
              {
                "maxLength": 120,
                "minLength": 1,
                "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "direction": {
            "description": "Which way the money moved, seen from the user: `outflow` is money leaving them, `inflow` is money reaching them. The amount is unsigned, so this is the only field that carries the sign.",
            "enum": ["inflow", "outflow"],
            "type": "string"
          },
          "money": {
            "$ref": "#/components/schemas/Money_1"
          },
          "notes": {
            "anyOf": [
              {
                "maxLength": 500,
                "minLength": 1,
                "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "occurredAt": {
            "$ref": "#/components/schemas/TransactionOccurredAt"
          }
        },
        "type": "object"
      },
      "expectedRevision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "type": "object"
  },
  "TransactionExtraction": {
    "additionalProperties": false,
    "properties": {
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "direction": {
        "description": "Which way the money moved, seen from the user: `outflow` is money leaving them, `inflow` is money reaching them. The amount is unsigned, so this is the only field that carries the sign.",
        "enum": ["inflow", "outflow"],
        "type": "string"
      },
      "money": {
        "$ref": "#/components/schemas/Money"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      }
    },
    "type": "object"
  },
  "Arrays_2": {
    "items": {
      "$ref": "#/components/schemas/Objects_"
    },
    "maxItems": 100,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/Objects_"
      }
    ],
    "type": "array"
  },
  "ResolveNeedsReviewItemInputPartial": {
    "additionalProperties": false,
    "properties": {
      "extraction": {
        "$ref": "#/components/schemas/TransactionExtraction"
      }
    },
    "type": "object"
  },
  "ReminderScheduleEditPartial": {
    "additionalProperties": false,
    "properties": {
      "cadence": {
        "$ref": "#/components/schemas/ReminderCadencePartial"
      },
      "expectedVersion": {
        "$ref": "#/components/schemas/ScheduleVersion"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "timing": {
        "$ref": "#/components/schemas/ReminderTimingPartial"
      }
    },
    "type": "object"
  },
  "Objects_1": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/InsightEventId"
      }
    },
    "type": "object"
  },
  "DeliveryEvidenceInputPartial": {
    "additionalProperties": false,
    "properties": {
      "channel": {
        "maxLength": 32,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "provider": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "providerMessageId": {
        "maxLength": 256,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "sentAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "type": "object"
  },
  "Objects_2": {
    "additionalProperties": false,
    "properties": {
      "accountId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "amountMode": {
        "enum": ["fixed", "estimated", "unknown"],
        "type": "string"
      },
      "cardPayment": {
        "type": "boolean"
      },
      "categoryId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "counterparty": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/CurrencyPartial"
      },
      "endDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "firstDate": {
        "pattern": "^20\\d{2}-\\d{2}-\\d{2}$",
        "type": "string"
      },
      "frequency": {
        "enum": [
          "weekly",
          "fortnightly",
          "twice-monthly",
          "monthly",
          "quarterly",
          "half-yearly",
          "yearly"
        ],
        "type": "string"
      },
      "kind": {
        "enum": ["income", "expense", "transfer"],
        "type": "string"
      },
      "money": {
        "additionalProperties": false,
        "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
        "properties": {
          "amount": {
            "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
            "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
            "type": "string"
          },
          "currency": {
            "$ref": "#/components/schemas/CurrencyPartial"
          }
        },
        "type": "object"
      },
      "monthDays": {
        "maxItems": 2,
        "minItems": 2,
        "prefixItems": [
          {
            "anyOf": [
              {
                "maximum": 31,
                "minimum": 1,
                "type": "integer"
              },
              {
                "enum": ["last"],
                "type": "string"
              }
            ]
          },
          {
            "anyOf": [
              {
                "maximum": 31,
                "minimum": 1,
                "type": "integer"
              },
              {
                "enum": ["last"],
                "type": "string"
              }
            ]
          }
        ],
        "type": "array"
      },
      "name": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      }
    },
    "type": "object"
  },
  "CurrencyPartial": {
    "description": "A recognized monetary ISO 4217 alphabetic code. It determines the maximum fractional precision of Money and does not imply that fidy operates in that currency's markets.",
    "enum": [
      "AED",
      "AFN",
      "ALL",
      "AMD",
      "AOA",
      "ARS",
      "AUD",
      "AWG",
      "AZN",
      "BAM",
      "BBD",
      "BDT",
      "BHD",
      "BIF",
      "BMD",
      "BND",
      "BOB",
      "BRL",
      "BSD",
      "BTN",
      "BWP",
      "BYN",
      "BZD",
      "CAD",
      "CDF",
      "CHF",
      "CLP",
      "CNY",
      "COP",
      "CRC",
      "CUP",
      "CVE",
      "CZK",
      "DJF",
      "DKK",
      "DOP",
      "DZD",
      "EGP",
      "ERN",
      "ETB",
      "EUR",
      "FJD",
      "FKP",
      "GBP",
      "GEL",
      "GHS",
      "GIP",
      "GMD",
      "GNF",
      "GTQ",
      "GYD",
      "HKD",
      "HNL",
      "HTG",
      "HUF",
      "IDR",
      "ILS",
      "INR",
      "IQD",
      "IRR",
      "ISK",
      "JMD",
      "JOD",
      "JPY",
      "KES",
      "KGS",
      "KHR",
      "KMF",
      "KPW",
      "KRW",
      "KWD",
      "KYD",
      "KZT",
      "LAK",
      "LBP",
      "LKR",
      "LRD",
      "LSL",
      "LYD",
      "MAD",
      "MDL",
      "MGA",
      "MKD",
      "MMK",
      "MNT",
      "MOP",
      "MRU",
      "MUR",
      "MVR",
      "MWK",
      "MXN",
      "MYR",
      "MZN",
      "NAD",
      "NGN",
      "NIO",
      "NOK",
      "NPR",
      "NZD",
      "OMR",
      "PAB",
      "PEN",
      "PGK",
      "PHP",
      "PKR",
      "PLN",
      "PYG",
      "QAR",
      "RON",
      "RSD",
      "RUB",
      "RWF",
      "SAR",
      "SBD",
      "SCR",
      "SDG",
      "SEK",
      "SGD",
      "SHP",
      "SLE",
      "SOS",
      "SRD",
      "SSP",
      "STN",
      "SVC",
      "SYP",
      "SZL",
      "THB",
      "TJS",
      "TMT",
      "TND",
      "TOP",
      "TRY",
      "TTD",
      "TWD",
      "TZS",
      "UAH",
      "UGX",
      "USD",
      "UYU",
      "UYW",
      "UZS",
      "VED",
      "VES",
      "VND",
      "VUV",
      "WST",
      "XAF",
      "XCD",
      "XCG",
      "XOF",
      "XPF",
      "YER",
      "ZAR",
      "ZMW",
      "ZWG"
    ],
    "type": "string"
  },
  "RememberInputPartial": {
    "additionalProperties": false,
    "properties": {
      "text": {
        "$ref": "#/components/schemas/MemoryTextEncoded"
      }
    },
    "type": "object"
  },
  "ReviseInputPartial": {
    "additionalProperties": false,
    "properties": {
      "text": {
        "$ref": "#/components/schemas/MemoryTextEncoded"
      }
    },
    "type": "object"
  },
  "BrowserContinuation": {
    "additionalProperties": false,
    "properties": {
      "expiresAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "url": {
        "pattern": "^https:\\/\\/app\\.fidyapp\\.com\\/connections\\/continue\\?attempt=[0-9a-f-]{36}$",
        "type": "string"
      }
    },
    "required": ["url", "expiresAt"],
    "type": "object"
  },
  "Union_9": {
    "anyOf": [
      {
        "enum": ["top", "bottom"],
        "type": "string"
      },
      {
        "$ref": "#/components/schemas/BesidePlacement"
      }
    ]
  },
  "Widget": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/SpendingChartWidget"
      },
      {
        "$ref": "#/components/schemas/BudgetBarWidget"
      },
      {
        "$ref": "#/components/schemas/TransactionListWidget"
      },
      {
        "$ref": "#/components/schemas/CustomMetricWidget"
      }
    ]
  },
  "WidgetId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "SplitWeight": {
    "maximum": 1000,
    "minimum": 0.001,
    "type": "number"
  },
  "LayoutRegionSelector_1": {
    "items": {
      "$ref": "#/components/schemas/WidgetId"
    },
    "maxItems": 24,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/WidgetId"
      }
    ],
    "type": "array",
    "uniqueItems": true
  },
  "Union_8": {
    "enum": ["row", "column"],
    "type": "string"
  },
  "Objects_16": {
    "additionalProperties": false,
    "properties": {
      "node": {
        "$ref": "#/components/schemas/LayoutNode"
      },
      "weight": {
        "$ref": "#/components/schemas/SplitWeight"
      }
    },
    "required": ["weight", "node"],
    "type": "object"
  },
  "DashboardWidgetView": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "result": {
            "$ref": "#/components/schemas/SpendingChartResult"
          },
          "widget": {
            "$ref": "#/components/schemas/SpendingChartWidget"
          }
        },
        "required": ["widget", "result"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "result": {
            "$ref": "#/components/schemas/BudgetBarResult"
          },
          "widget": {
            "$ref": "#/components/schemas/BudgetBarWidget"
          }
        },
        "required": ["widget", "result"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "result": {
            "$ref": "#/components/schemas/TransactionListResult"
          },
          "widget": {
            "$ref": "#/components/schemas/TransactionListWidget"
          }
        },
        "required": ["widget", "result"],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "result": {
            "$ref": "#/components/schemas/CustomMetricResult"
          },
          "widget": {
            "$ref": "#/components/schemas/CustomMetricWidget"
          }
        },
        "required": ["widget", "result"],
        "type": "object"
      }
    ]
  },
  "Objects_17": {
    "additionalProperties": false,
    "properties": {
      "node": {
        "$ref": "#/components/schemas/DashboardViewLayout"
      },
      "weight": {
        "$ref": "#/components/schemas/SplitWeight"
      }
    },
    "required": ["weight", "node"],
    "type": "object"
  },
  "SpendingChartTemplate": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "groupBy": {
        "$ref": "#/components/schemas/Union_5"
      },
      "period": {
        "$ref": "#/components/schemas/Union_6"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["spending-chart"],
        "type": "string"
      }
    },
    "required": ["type", "groupBy", "period"],
    "type": "object"
  },
  "BudgetBarTemplate": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["budget-bar"],
        "type": "string"
      }
    },
    "required": ["type", "categoryId", "currency"],
    "type": "object"
  },
  "TransactionListTemplate": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "limit": {
        "$ref": "#/components/schemas/TransactionListLimit"
      },
      "search": {
        "maxLength": 100,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["transaction-list"],
        "type": "string"
      }
    },
    "required": ["type", "limit"],
    "type": "object"
  },
  "CustomMetricTemplate": {
    "additionalProperties": false,
    "properties": {
      "aggregation": {
        "$ref": "#/components/schemas/Union_7"
      },
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "label": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "period": {
        "$ref": "#/components/schemas/Union_6"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["custom-metric"],
        "type": "string"
      }
    },
    "required": ["type", "label", "aggregation", "period"],
    "type": "object"
  },
  "Objects_32": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/NeedsReviewItemId"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": ["id", "revision"],
    "type": "object"
  },
  "EmailForwardingAddressId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Arrays_5": {
    "items": {
      "$ref": "#/components/schemas/Objects_35"
    },
    "type": "array"
  },
  "Union_14": {
    "enum": [
      "malformed-source-row",
      "missing-required-fact",
      "ambiguous-direction",
      "ambiguous-currency",
      "canonical-validation-failed",
      "mapping-unavailable",
      "model-unavailable"
    ],
    "type": "string"
  },
  "IngestSampleId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "Arrays_6": {
    "items": {
      "$ref": "#/components/schemas/Objects_35"
    },
    "type": "array"
  },
  "Union_15": {
    "enum": ["provider-retrieval-failed", "processing-interrupted", "consent-revoked"],
    "type": "string"
  },
  "ConfirmationDay": {
    "additionalProperties": false,
    "properties": {
      "from": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "localDate": {
        "$ref": "#/components/schemas/ReminderAnchorDate"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "toExclusive": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["localDate", "timeZone", "from", "toExclusive"],
    "type": "object"
  },
  "RecurringDigestItem": {
    "additionalProperties": false,
    "properties": {
      "cadence": {
        "$ref": "#/components/schemas/Objects_43"
      },
      "confirmationId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      },
      "confirmedAt": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "counterparty": {
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "money": {
        "$ref": "#/components/schemas/Objects_42"
      },
      "seriesId": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
        "type": "string"
      }
    },
    "required": ["confirmationId", "seriesId", "counterparty", "money", "cadence", "confirmedAt"],
    "type": "object"
  },
  "ReminderAnchorDate": {
    "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
    "type": "string"
  },
  "MoneyGroup": {
    "additionalProperties": false,
    "properties": {
      "currency": {
        "$ref": "#/components/schemas/Currency"
      },
      "inflow": {
        "$ref": "#/components/schemas/Money_2"
      },
      "outflow": {
        "$ref": "#/components/schemas/Money_2"
      }
    },
    "required": ["currency", "inflow", "outflow"],
    "type": "object"
  },
  "DeliveryAttemptId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "MemoryText": {
    "maxLength": 2000,
    "minLength": 1,
    "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
    "type": "string"
  },
  "Objects_43": {
    "additionalProperties": false,
    "properties": {
      "kind": {
        "enum": ["monthly"],
        "type": "string"
      }
    },
    "required": ["kind"],
    "type": "object"
  },
  "Objects_42": {
    "additionalProperties": false,
    "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
    "properties": {
      "amount": {
        "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
        "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      }
    },
    "required": ["amount", "currency"],
    "type": "object"
  },
  "Objects_52": {
    "additionalProperties": false,
    "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
    "properties": {
      "amount": {
        "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
        "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      }
    },
    "required": ["amount", "currency"],
    "type": "object"
  },
  "BillingPeriod": {
    "enum": ["weekly", "monthly", "yearly"],
    "type": "string"
  },
  "PriceId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "TaxTreatment": {
    "enum": ["not-taxable"],
    "type": "string"
  },
  "BillingAttemptId": {
    "format": "uuid",
    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
    "type": "string"
  },
  "LaunchPaymentMethods": {
    "maxItems": 3,
    "minItems": 3,
    "prefixItems": [
      {
        "enum": ["card"],
        "type": "string"
      },
      {
        "enum": ["nequi"],
        "type": "string"
      },
      {
        "enum": ["daviplata"],
        "type": "string"
      }
    ],
    "type": "array"
  },
  "RenewalTerms": {
    "additionalProperties": false,
    "properties": {
      "automaticRenewal": {
        "enum": [true],
        "type": "boolean"
      },
      "cancellation": {
        "enum": ["future-renewals-only"],
        "type": "string"
      },
      "paidAccessEnds": {
        "enum": ["paid-period-end"],
        "type": "string"
      },
      "renewalReminder": {
        "enum": ["none"],
        "type": "string"
      }
    },
    "required": ["automaticRenewal", "renewalReminder", "cancellation", "paidAccessEnds"],
    "type": "object"
  },
  "AccountHints": {
    "additionalProperties": false,
    "properties": {
      "accountLastFour": {
        "$ref": "#/components/schemas/LastFourDigits"
      },
      "cardLastFour": {
        "$ref": "#/components/schemas/LastFourDigits"
      },
      "instrumentLabel": {
        "type": "string"
      }
    },
    "type": "object"
  },
  "NotificationFormatId": {
    "maxLength": 64,
    "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    "type": "string"
  },
  "Objects_24": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "createdAt": {
        "$ref": "#/components/schemas/TransactionCreatedAt"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "notes": {
        "maxLength": 500,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      },
      "presentation": {
        "$ref": "#/components/schemas/Objects_21"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "required": [
      "id",
      "money",
      "direction",
      "categoryId",
      "occurredAt",
      "createdAt",
      "revision",
      "presentation"
    ],
    "type": "object"
  },
  "Money": {
    "additionalProperties": false,
    "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
    "properties": {
      "amount": {
        "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
        "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/CurrencyPartial"
      }
    },
    "type": "object"
  },
  "SetTitlePartial": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["set-title"],
        "type": "string"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      }
    },
    "type": "object"
  },
  "AddWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "at": {
        "$ref": "#/components/schemas/Union_1"
      },
      "op": {
        "enum": ["add-widget"],
        "type": "string"
      },
      "widget": {
        "$ref": "#/components/schemas/WidgetPartial"
      }
    },
    "type": "object"
  },
  "RemoveWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["remove-widget"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "type": "object"
  },
  "MoveWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "at": {
        "$ref": "#/components/schemas/Union_1"
      },
      "op": {
        "enum": ["move-widget"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "type": "object"
  },
  "SwapWidgetsPartial": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["swap-widgets"],
        "type": "string"
      },
      "widgetId": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "withWidgetId": {
        "$ref": "#/components/schemas/WidgetId"
      }
    },
    "type": "object"
  },
  "ResizeRegionPartial": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["resize-region"],
        "type": "string"
      },
      "size": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["weight"],
                "type": "string"
              },
              "weight": {
                "$ref": "#/components/schemas/SplitWeight"
              }
            },
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": ["ratio"],
                "type": "string"
              },
              "ratio": {
                "enum": ["one-quarter", "one-third", "one-half", "two-thirds", "three-quarters"],
                "type": "string"
              }
            },
            "type": "object"
          }
        ]
      },
      "widgetIds": {
        "$ref": "#/components/schemas/LayoutRegionSelector"
      }
    },
    "type": "object"
  },
  "UpdateWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "op": {
        "enum": ["update-widget"],
        "type": "string"
      },
      "widget": {
        "$ref": "#/components/schemas/WidgetPartial"
      }
    },
    "type": "object"
  },
  "Money_1": {
    "additionalProperties": false,
    "description": "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
    "properties": {
      "amount": {
        "description": "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
        "pattern": "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
        "type": "string"
      },
      "currency": {
        "$ref": "#/components/schemas/CurrencyPartial"
      }
    },
    "type": "object"
  },
  "Objects_": {
    "additionalProperties": false,
    "properties": {
      "id": {
        "$ref": "#/components/schemas/NeedsReviewItemId"
      },
      "revision": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      }
    },
    "type": "object"
  },
  "ReminderCadencePartial": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["daily"],
            "type": "string"
          }
        },
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["weekdays"],
            "type": "string"
          }
        },
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "anchorDate": {
            "$ref": "#/components/schemas/ReminderAnchorDate"
          },
          "kind": {
            "enum": ["every-three-days"],
            "type": "string"
          }
        },
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": ["weekly"],
            "type": "string"
          },
          "weekday": {
            "maximum": 6,
            "minimum": 0,
            "type": "integer"
          }
        },
        "type": "object"
      }
    ]
  },
  "ReminderTimingPartial": {
    "additionalProperties": false,
    "properties": {
      "hour": {
        "maximum": 23,
        "minimum": 0,
        "type": "integer"
      },
      "minute": {
        "maximum": 59,
        "minimum": 0,
        "type": "integer"
      }
    },
    "type": "object"
  },
  "BesidePlacement": {
    "additionalProperties": false,
    "properties": {
      "axis": {
        "$ref": "#/components/schemas/Union_8"
      },
      "besideWidget": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "side": {
        "enum": ["before", "after"],
        "type": "string"
      }
    },
    "required": ["besideWidget", "axis", "side"],
    "type": "object"
  },
  "SpendingChartWidget": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "groupBy": {
        "$ref": "#/components/schemas/Union_5"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "period": {
        "$ref": "#/components/schemas/Union_6"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["spending-chart"],
        "type": "string"
      }
    },
    "required": ["id", "type", "groupBy", "period"],
    "type": "object"
  },
  "BudgetBarWidget": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "currency": {
        "$ref": "#/components/schemas/Currency"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["budget-bar"],
        "type": "string"
      }
    },
    "required": ["id", "type", "categoryId", "currency"],
    "type": "object"
  },
  "TransactionListWidget": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "limit": {
        "$ref": "#/components/schemas/TransactionListLimit"
      },
      "search": {
        "maxLength": 100,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["transaction-list"],
        "type": "string"
      }
    },
    "required": ["id", "type", "limit"],
    "type": "object"
  },
  "CustomMetricWidget": {
    "additionalProperties": false,
    "properties": {
      "aggregation": {
        "$ref": "#/components/schemas/Union_7"
      },
      "categories": {
        "$ref": "#/components/schemas/Arrays_3"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "label": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "period": {
        "$ref": "#/components/schemas/Union_6"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["custom-metric"],
        "type": "string"
      }
    },
    "required": ["id", "type", "label", "aggregation", "period"],
    "type": "object"
  },
  "SpendingChartResult": {
    "additionalProperties": false,
    "properties": {
      "appliedPeriod": {
        "$ref": "#/components/schemas/AppliedDashboardPeriod"
      },
      "buckets": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "key": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {
                    "category": {
                      "$ref": "#/components/schemas/Category"
                    },
                    "kind": {
                      "enum": ["category"],
                      "type": "string"
                    }
                  },
                  "required": ["kind", "category"],
                  "type": "object"
                },
                {
                  "additionalProperties": false,
                  "properties": {
                    "date": {
                      "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])$",
                      "type": "string"
                    },
                    "kind": {
                      "enum": ["day"],
                      "type": "string"
                    }
                  },
                  "required": ["kind", "date"],
                  "type": "object"
                },
                {
                  "additionalProperties": false,
                  "properties": {
                    "kind": {
                      "enum": ["month"],
                      "type": "string"
                    },
                    "month": {
                      "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])$",
                      "type": "string"
                    }
                  },
                  "required": ["kind", "month"],
                  "type": "object"
                }
              ]
            },
            "moneyGroups": {
              "$ref": "#/components/schemas/MoneyGroups"
            }
          },
          "required": ["key", "moneyGroups"],
          "type": "object"
        },
        "type": "array"
      }
    },
    "required": ["appliedPeriod", "buckets"],
    "type": "object"
  },
  "BudgetBarResult": {
    "anyOf": [
      {
        "additionalProperties": false,
        "properties": {
          "appliedPeriod": {
            "$ref": "#/components/schemas/AppliedDashboardPeriod"
          },
          "availability": {
            "enum": ["available"],
            "type": "string"
          },
          "cap": {
            "$ref": "#/components/schemas/Money_2"
          },
          "category": {
            "$ref": "#/components/schemas/Category"
          },
          "currency": {
            "$ref": "#/components/schemas/Currency"
          },
          "spent": {
            "$ref": "#/components/schemas/Money_2"
          },
          "status": {
            "anyOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "remaining": {
                    "$ref": "#/components/schemas/Money_2"
                  },
                  "type": {
                    "enum": ["under"],
                    "type": "string"
                  }
                },
                "required": ["type", "remaining"],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "type": {
                    "enum": ["reached"],
                    "type": "string"
                  }
                },
                "required": ["type"],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "overBy": {
                    "$ref": "#/components/schemas/Money_2"
                  },
                  "type": {
                    "enum": ["over"],
                    "type": "string"
                  }
                },
                "required": ["type", "overBy"],
                "type": "object"
              }
            ]
          }
        },
        "required": [
          "availability",
          "appliedPeriod",
          "category",
          "currency",
          "cap",
          "spent",
          "status"
        ],
        "type": "object"
      },
      {
        "additionalProperties": false,
        "properties": {
          "appliedPeriod": {
            "$ref": "#/components/schemas/AppliedDashboardPeriod"
          },
          "availability": {
            "enum": ["missing-budget"],
            "type": "string"
          },
          "category": {
            "$ref": "#/components/schemas/Category"
          },
          "currency": {
            "$ref": "#/components/schemas/Currency"
          }
        },
        "required": ["availability", "appliedPeriod", "category", "currency"],
        "type": "object"
      }
    ]
  },
  "TransactionListResult": {
    "additionalProperties": false,
    "properties": {
      "transactions": {
        "items": {
          "$ref": "#/components/schemas/DashboardTransaction"
        },
        "type": "array"
      }
    },
    "required": ["transactions"],
    "type": "object"
  },
  "CustomMetricResult": {
    "additionalProperties": false,
    "properties": {
      "appliedPeriod": {
        "$ref": "#/components/schemas/AppliedDashboardPeriod"
      },
      "moneyGroups": {
        "$ref": "#/components/schemas/MoneyGroups"
      }
    },
    "required": ["appliedPeriod", "moneyGroups"],
    "type": "object"
  },
  "Arrays_3": {
    "items": {
      "$ref": "#/components/schemas/CategoryId"
    },
    "maxItems": 16,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/CategoryId"
      }
    ],
    "type": "array",
    "uniqueItems": true
  },
  "Union_5": {
    "enum": ["category", "day", "month"],
    "type": "string"
  },
  "Union_6": {
    "enum": ["this-week", "this-month", "last-week", "last-month", "last-7-days", "last-30-days"],
    "type": "string"
  },
  "TransactionListLimit": {
    "maximum": 50,
    "minimum": 1,
    "type": "integer"
  },
  "Union_7": {
    "enum": ["sum", "average", "maximum"],
    "type": "string"
  },
  "Objects_35": {
    "additionalProperties": false,
    "properties": {
      "message": {
        "type": "string"
      },
      "path": {
        "type": "string"
      }
    },
    "required": ["path", "message"],
    "type": "object"
  },
  "LastFourDigits": {
    "pattern": "^[0-9]{4}$",
    "type": "string"
  },
  "Union_1": {
    "anyOf": [
      {
        "enum": ["top", "bottom"],
        "type": "string"
      },
      {
        "$ref": "#/components/schemas/BesidePlacementPartial"
      }
    ]
  },
  "WidgetPartial": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/SpendingChartWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/BudgetBarWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/TransactionListWidgetPartial"
      },
      {
        "$ref": "#/components/schemas/CustomMetricWidgetPartial"
      }
    ]
  },
  "LayoutRegionSelector": {
    "items": {
      "$ref": "#/components/schemas/WidgetId"
    },
    "maxItems": 24,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/WidgetId"
      }
    ],
    "type": "array",
    "uniqueItems": true
  },
  "AppliedDashboardPeriod": {
    "additionalProperties": false,
    "properties": {
      "from": {
        "$ref": "#/components/schemas/UtcTimestamp"
      },
      "requested": {
        "$ref": "#/components/schemas/Union_6"
      },
      "timeZone": {
        "$ref": "#/components/schemas/IanaTimeZone"
      },
      "toExclusive": {
        "$ref": "#/components/schemas/UtcTimestamp"
      }
    },
    "required": ["requested", "from", "toExclusive", "timeZone"],
    "type": "object"
  },
  "DashboardTransaction": {
    "additionalProperties": false,
    "properties": {
      "category": {
        "$ref": "#/components/schemas/Category"
      },
      "counterparty": {
        "description": "The person or organization on the other side when the captured material explicitly identifies one — \"El Corral\", \"Claro\", \"Acme S.A.\". Omit this field rather than inferring a business, using a purchased item or purpose, or sending a placeholder.",
        "maxLength": 120,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "direction": {
        "$ref": "#/components/schemas/Union_2"
      },
      "id": {
        "$ref": "#/components/schemas/TransactionId"
      },
      "money": {
        "$ref": "#/components/schemas/Money_2"
      },
      "occurredAt": {
        "$ref": "#/components/schemas/TransactionOccurredAt"
      }
    },
    "required": ["id", "money", "direction", "category", "occurredAt"],
    "type": "object"
  },
  "BesidePlacementPartial": {
    "additionalProperties": false,
    "properties": {
      "axis": {
        "enum": ["row", "column"],
        "type": "string"
      },
      "besideWidget": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "side": {
        "enum": ["before", "after"],
        "type": "string"
      }
    },
    "type": "object"
  },
  "SpendingChartWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_1"
      },
      "groupBy": {
        "enum": ["category", "day", "month"],
        "type": "string"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "period": {
        "$ref": "#/components/schemas/Union_"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["spending-chart"],
        "type": "string"
      }
    },
    "type": "object"
  },
  "BudgetBarWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "categoryId": {
        "$ref": "#/components/schemas/CategoryId"
      },
      "currency": {
        "$ref": "#/components/schemas/CurrencyPartial"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["budget-bar"],
        "type": "string"
      }
    },
    "type": "object"
  },
  "TransactionListWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "categories": {
        "$ref": "#/components/schemas/Arrays_1"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "limit": {
        "$ref": "#/components/schemas/TransactionListLimit"
      },
      "search": {
        "maxLength": 100,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["transaction-list"],
        "type": "string"
      }
    },
    "type": "object"
  },
  "CustomMetricWidgetPartial": {
    "additionalProperties": false,
    "properties": {
      "aggregation": {
        "enum": ["sum", "average", "maximum"],
        "type": "string"
      },
      "categories": {
        "$ref": "#/components/schemas/Arrays_1"
      },
      "id": {
        "$ref": "#/components/schemas/WidgetId"
      },
      "label": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "period": {
        "$ref": "#/components/schemas/Union_"
      },
      "title": {
        "maxLength": 80,
        "minLength": 1,
        "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
        "type": "string"
      },
      "type": {
        "enum": ["custom-metric"],
        "type": "string"
      }
    },
    "type": "object"
  },
  "Arrays_1": {
    "items": {
      "$ref": "#/components/schemas/CategoryId"
    },
    "maxItems": 16,
    "minItems": 1,
    "prefixItems": [
      {
        "$ref": "#/components/schemas/CategoryId"
      }
    ],
    "type": "array",
    "uniqueItems": true
  },
  "Union_": {
    "enum": ["this-week", "this-month", "last-week", "last-month", "last-7-days", "last-30-days"],
    "type": "string"
  }
}
```
