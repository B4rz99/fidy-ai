import { type JsonSchema, Option, Predicate, Schema } from "effect";

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

type ShapeContext = Readonly<{
  definitions: Readonly<Record<string, unknown>>;
  seen: ReadonlySet<string>;
}>;

const scalarShape = (schema: Record<string, unknown>): string => {
  const type =
    typeof schema.type === "string" ? schema.type : JSON.stringify(schema.type ?? "unknown");
  if (typeof schema.format === "string") return `${type}(${schema.format})`;
  return typeof schema.pattern === "string" ? `${type} matching /${schema.pattern}/` : type;
};

const propertyName = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);

const objectShape = (
  properties: object,
  required: ReadonlyArray<unknown>,
  context: ShapeContext
): string =>
  `{${Object.entries(properties)
    .map(
      ([name, node]) =>
        `${propertyName(name)}${required.includes(name) ? "" : "?"}:${schemaShape(node, context)}`
    )
    .join(",")}}`;

const compositeShape = (schema: Record<string, unknown>, context: ShapeContext): string => {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) {
      return `(${alternatives.map((node) => schemaShape(node, context)).join(key === "allOf" ? "&" : "|")})`;
    }
  }
  return "";
};

const inlineEnumMaximum = 5;
const enumShape = (values: ReadonlyArray<unknown>): string =>
  values.length > inlineEnumMaximum
    ? `one of ${JSON.stringify(values)}`
    : values.map((item) => JSON.stringify(item)).join("|");

const referenceShape = (value: unknown, context: ShapeContext): Option.Option<string> => {
  if (
    Predicate.isObject(value) &&
    typeof value.$ref === "string" &&
    value.$ref.startsWith("#/$defs/")
  ) {
    const name = decodeURIComponent(value.$ref.slice("#/$defs/".length))
      .replace(/~1/gu, "/")
      .replace(/~0/gu, "~");
    const target = context.definitions[name];
    if (context.seen.has(name) || target === undefined) return Option.some(name);
    return Option.some(schemaShape(target, { ...context, seen: new Set([...context.seen, name]) }));
  }
  return Option.none();
};

const literalShape = (schema: Record<string, unknown>): Option.Option<string> => {
  if ("const" in schema) return Option.some(JSON.stringify(schema.const));
  return Array.isArray(schema.enum) ? Option.some(enumShape(schema.enum)) : Option.none();
};

const schemaShape = (value: unknown, context: ShapeContext): string => {
  const reference = referenceShape(value, context);
  if (Option.isSome(reference)) return reference.value;
  if (!Predicate.isObject(value)) return JSON.stringify(value);
  const literal = literalShape(value);
  if (Option.isSome(literal)) return literal.value;
  const composite = compositeShape(value, context);
  if (composite !== "") return composite;
  if (Predicate.isObject(value.properties)) {
    return objectShape(
      value.properties,
      Array.isArray(value.required) ? value.required : [],
      context
    );
  }
  return value.type === "array"
    ? `Array<${schemaShape(value.items, context)}>`
    : scalarShape(value);
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

const constraintDescription = (
  schema: Record<string, unknown>,
  definitions: Readonly<Record<string, unknown>>
): string =>
  ["$ref", "const", "pattern", "anyOf", "oneOf", "allOf"].some((key) => key in schema)
    ? `Shape: ${schemaShape(schema, { definitions, seen: new Set() })}`
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

const compactNode = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>,
  describe = true
): unknown => {
  if (!Predicate.isObject(value)) return value;
  const source = compactNumericBounds(value);
  const describeChildren = describe && !["anyOf", "oneOf", "allOf"].some((key) => key in source);
  const schema = Object.fromEntries(
    Object.entries(source).map(([key, child]) => {
      if (schemaMaps.has(key) && Predicate.isObject(child)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, node]) => [
              name,
              compactNode(node, definitions, describeChildren),
            ])
          ),
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(child)) {
        return [key, child.map((node) => compactNode(node, definitions, describeChildren))];
      }
      return [
        key,
        schemaNodes.has(key) ? compactNode(child, definitions, describeChildren) : child,
      ];
    })
  );
  const constraints = describe ? constraintDescription(source, definitions) : "";
  if (constraints !== "") {
    schema.description = [schema.description, constraints].filter(Boolean).join("\n");
  }
  if (Predicate.isObject(schema.properties)) schema.additionalProperties = false;
  return compactHomogeneousArray(schema);
};

export const openAiProviderSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(Schema.toEncoded(schema), {
    referencePolicy: ({ identifier, occurrences }) => (occurrences > 1 ? identifier : undefined),
  });
  const compacted = compactNode(document.schema, document.definitions);
  if (!Predicate.isObject(compacted)) throw new Error("Provider schema must remain an object");
  return Object.keys(document.definitions).length === 0
    ? compacted
    : {
        ...compacted,
        $defs: Object.fromEntries(
          Object.entries(document.definitions).map(([name, node]) => [
            name,
            compactNode(node, document.definitions),
          ])
        ),
      };
};
