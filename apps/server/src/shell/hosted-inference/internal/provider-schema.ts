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

const scalarShape = (schema: Record<string, unknown>): string => {
  const type =
    typeof schema.type === "string" ? schema.type : JSON.stringify(schema.type ?? "unknown");
  if (typeof schema.format === "string") return `${type}(${schema.format})`;
  return typeof schema.pattern === "string" ? `${type} matching /${schema.pattern}/` : type;
};

const propertyName = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);

const objectShape = (properties: object, required: ReadonlyArray<unknown>): string =>
  `{${Object.entries(properties)
    .map(
      ([name, node]) =>
        `${propertyName(name)}${required.includes(name) ? "" : "?"}:${schemaShape(node)}`
    )
    .join(",")}}`;

const compositeShape = (schema: Record<string, unknown>): string => {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) {
      return `(${alternatives.map(schemaShape).join(key === "allOf" ? " & " : " | ")})`;
    }
  }
  return "";
};

const inlineEnumMaximum = 5;
const enumShape = (values: ReadonlyArray<unknown>): string =>
  values.length > inlineEnumMaximum
    ? `one of ${JSON.stringify(values)}`
    : values.map((item) => JSON.stringify(item)).join(" | ");

const schemaShape = (value: unknown): string => {
  if (!Predicate.isObject(value)) return JSON.stringify(value);
  if ("const" in value) return JSON.stringify(value.const);
  if (Array.isArray(value.enum)) {
    return enumShape(value.enum);
  }
  const composite = compositeShape(value);
  if (composite !== "") return composite;
  if (Predicate.isObject(value.properties)) {
    return objectShape(value.properties, Array.isArray(value.required) ? value.required : []);
  }
  return value.type === "array" ? `Array<${schemaShape(value.items)}>` : scalarShape(value);
};

const compactHomogeneousArray = (schema: Record<string, unknown>): Record<string, unknown> => {
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

const constraintDescription = (schema: Record<string, unknown>): string =>
  ["const", "pattern", "anyOf", "oneOf", "allOf"].some((key) => key in schema)
    ? `Required shape: ${schemaShape(schema)}`
    : "";

const compactNumericBounds = (schema: Record<string, unknown>): Record<string, unknown> => {
  if ((schema.type !== "integer" && schema.type !== "number") || !Array.isArray(schema.allOf)) {
    return schema;
  }
  const members = schema.allOf.filter(Predicate.isObject);
  if (
    members.length !== schema.allOf.length ||
    !members.every(
      (member) =>
        Object.keys(member).length > 0 &&
        Object.entries(member).every(
          ([key, value]) =>
            (key === "minimum" || key === "maximum") &&
            Predicate.isNumber(value) &&
            Number.isFinite(value)
        )
    )
  ) {
    return schema;
  }
  const bounds = [schema, ...members];
  const minimum = bounds.map((bound) => bound.minimum).filter(Predicate.isNumber);
  const maximum = bounds.map((bound) => bound.maximum).filter(Predicate.isNumber);
  const { allOf: _allOf, ...scalar } = schema;
  return {
    ...scalar,
    ...(minimum.length === 0 ? {} : { minimum: Math.max(...minimum) }),
    ...(maximum.length === 0 ? {} : { maximum: Math.min(...maximum) }),
  };
};

const compactNode = (value: unknown, describe = true): unknown => {
  if (!Predicate.isObject(value)) return value;
  const source = compactNumericBounds(value);
  const describeChildren = describe && !["anyOf", "oneOf", "allOf"].some((key) => key in source);
  const schema = Object.fromEntries(
    Object.entries(source).map(([key, child]) => {
      if (schemaMaps.has(key) && Predicate.isObject(child)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, node]) => [name, compactNode(node, describeChildren)])
          ),
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(child)) {
        return [key, child.map((node) => compactNode(node, describeChildren))];
      }
      return [key, schemaNodes.has(key) ? compactNode(child, describeChildren) : child];
    })
  );
  // Gemma's tool template omits unions, constants, and patterns but renders descriptions.
  // Derive its guidance from the canonical schema; decoding still enforces the original contract.
  const constraints = describe ? constraintDescription(source) : "";
  if (constraints !== "") {
    schema.description = [schema.description, constraints].filter(Boolean).join("\n");
  }
  return compactHomogeneousArray(schema);
};

export const workersAiProviderSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(Schema.toEncoded(schema), {
    referencePolicy: () => undefined,
  });
  const compacted = compactNode(document.schema);
  if (!Predicate.isObject(compacted)) throw new Error("Provider schema must remain an object");
  return Object.keys(document.definitions).length === 0
    ? compacted
    : { ...compacted, $defs: document.definitions };
};
