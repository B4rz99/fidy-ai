import { type JsonSchema, Predicate, Schema } from "effect";

const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaNodes = new Set([
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

const compactNode = (value: unknown): unknown => {
  if (!Predicate.isObject(value)) return value;
  const schema = Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (schemaMaps.has(key) && Predicate.isObject(child)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, node]) => [name, compactNode(node)])
          ),
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(child)) return [key, child.map(compactNode)];
      return [key, schemaNodes.has(key) ? compactNode(child) : child];
    })
  );
  if (
    schema.type === "array" &&
    Array.isArray(schema.prefixItems) &&
    schema.prefixItems.length === 1 &&
    schema.items !== undefined &&
    JSON.stringify(schema.prefixItems[0]) === JSON.stringify(schema.items)
  ) {
    // A homogeneous head/rest pair has the same validation as items alone.
    // Keep minItems/maxItems; annotation and literal values are never traversed.
    const { prefixItems: _prefixItems, ...homogeneous } = schema;
    return homogeneous;
  }
  return schema;
};

export const workersAiProviderSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(Schema.toEncoded(schema), {
    referencePolicy: () => undefined,
  });
  const compacted = compactNode(document.schema);
  if (!Predicate.isObject(compacted)) throw new Error("Provider schema must remain an object");
  return { ...compacted, $defs: document.definitions };
};
