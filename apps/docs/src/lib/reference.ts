import { Predicate, Schema } from "effect";
import referenceText from "../../public/reference/openapi.json?raw";
import { ReferenceArtifact, ReferenceOperation } from "./reference-contract";

const Content = Schema.Record(Schema.String, Schema.Struct({ schema: Schema.JsonObject }));
const Parameter = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header", "cookie"]),
  required: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  schema: Schema.JsonObject,
});
const Operation = Schema.Struct({
  ...ReferenceOperation.fields,
  parameters: Schema.Array(Parameter),
  requestBody: Schema.optionalKey(
    Schema.Struct({ content: Content, required: Schema.optionalKey(Schema.Boolean) })
  ),
  responses: Schema.Record(
    Schema.String,
    Schema.Struct({ description: Schema.String, content: Schema.optionalKey(Content) })
  ),
});
const document = Schema.decodeUnknownSync(Schema.fromJsonString(ReferenceArtifact))(referenceText);

export const referenceOperations = Object.entries(document.paths)
  .flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, raw]) => {
      const declaration = Schema.decodeUnknownSync(Operation)(raw);
      const [domain, name] = declaration.operationId.split(".");
      return { path, method: method.toUpperCase(), raw, declaration, domain, name };
    })
  )
  .sort((left, right) => left.declaration.operationId.localeCompare(right.declaration.operationId));

export const referenceSchemas = Object.entries(document.components.schemas);

export const operationFor = (id: string): (typeof referenceOperations)[number] => {
  const operation = referenceOperations.find(
    (entry) => `reference/${entry.declaration.operationId.toLowerCase()}` === id
  );
  if (!operation) throw new Error(`Missing published operation: ${id}`);
  return operation;
};

const SchemaView = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.JsonObject)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.JsonObject)),
  oneOf: Schema.optionalKey(Schema.Array(Schema.JsonObject)),
  allOf: Schema.optionalKey(Schema.Array(Schema.JsonObject)),
  description: Schema.optionalKey(Schema.String),
});
export type SchemaView = typeof SchemaView.Type;

export const schemaView = Schema.decodeUnknownSync(SchemaView);

export const schemaTarget = (schema: Schema.JsonObject): string => {
  const reference = schemaView(schema).$ref;
  if (!reference) return "";
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) throw new Error("Unsupported public schema reference");
  const name = reference.slice(prefix.length);
  if (!Object.hasOwn(document.components.schemas, name)) {
    throw new Error(`Missing public schema: ${name}`);
  }
  return name;
};

export const resolveSchema = (schema: Schema.JsonObject): Schema.JsonObject => {
  const target = schemaTarget(schema);
  return target ? (document.components.schemas[target] ?? schema) : schema;
};

export const schemaType = (schema: Schema.JsonObject): string => {
  const view = schemaView(schema);
  const target = schemaTarget(schema);
  if (target) return target;
  if (view.type) return Predicate.isString(view.type) ? view.type : view.type.join(" | ");
  if (view.anyOf) return "anyOf";
  if (view.oneOf) return "oneOf";
  if (view.allOf) return "allOf";
  return "JSON Schema";
};

export const schemaProperties = (
  schema: Schema.JsonObject
): ReadonlyArray<{ name: string; schema: Schema.JsonObject; required: boolean }> => {
  const view = schemaView(resolveSchema(schema));
  return Object.entries(view.properties ?? {})
    .map(([name, property]) => ({
      name,
      schema: property,
      required: view.required?.includes(name) ?? false,
    }))
    .sort((left, right) => Number(right.required) - Number(left.required));
};
