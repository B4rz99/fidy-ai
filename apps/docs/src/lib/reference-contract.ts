import { Schema } from "effect";

export const ReferenceArtifact = Schema.Struct({
  openapi: Schema.String,
  info: Schema.JsonObject,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.JsonObject)),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.JsonObject) }),
});
export const ReferenceOperation = Schema.Struct({
  operationId: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/u)
  ),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.Array(Schema.JsonObject),
  requestBody: Schema.optionalKey(Schema.JsonObject),
  responses: Schema.Record(Schema.String, Schema.JsonObject),
  "x-fidy-access": Schema.Struct({
    type: Schema.Literal("user-owned-agent-scoped"),
    scope: Schema.Union([
      Schema.Struct({
        evaluation: Schema.Literal("operation"),
        capability: Schema.Literals(["read", "write", "dashboard"]),
      }),
      Schema.Struct({ evaluation: Schema.Literal("children") }),
    ]),
  }),
  "x-fidy-agent-confirmation": Schema.Literals(["required", "not-required"]),
  "x-fidy-operation-kind": Schema.Literals(["query", "mutation"]),
  "x-fidy-required-tier": Schema.Literals(["free", "pro"]),
});
