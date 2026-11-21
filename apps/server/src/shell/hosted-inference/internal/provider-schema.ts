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

type SummaryContext = Readonly<{
  definitions: JsonSchema.Definitions;
  seen: ReadonlySet<string>;
}>;

const scalarSummary = (schema: JsonSchema.JsonSchema): string => {
  const type = Predicate.isString(schema.type)
    ? schema.type
    : JSON.stringify(schema.type ?? "unknown");

  if (Predicate.isString(schema.format)) return `${type}(${schema.format})`;

  return Predicate.isString(schema.pattern) ? `${type} matching /${schema.pattern}/` : type;
};

const propertyName = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);

const objectSummary = (
  properties: JsonSchema.JsonSchema,
  required: ReadonlyArray<unknown>,
  context: SummaryContext
): string =>
  `{${Object.entries(properties)
    .map(
      ([name, node]) =>
        `${propertyName(name)}${required.includes(name) ? "" : "?"}:${schemaSummary(node, context)}`
    )
    .join(",")}}`;

const compositeSummary = (schema: JsonSchema.JsonSchema, context: SummaryContext): string => {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = schema[key];

    if (Array.isArray(alternatives)) {
      return `(${alternatives.map((node) => schemaSummary(node, context)).join(key === "allOf" ? "&" : "|")})`;
    }
  }

  return "";
};

const inlineEnumMaximum = 5;

const enumSummary = (values: ReadonlyArray<unknown>): string =>
  values.length > inlineEnumMaximum
    ? `one of ${JSON.stringify(values)}`
    : values.map((item) => JSON.stringify(item)).join("|");

const referenceSummary = (value: unknown, context: SummaryContext): Option.Option<string> => {
  if (
    Predicate.isObject(value) &&
    Predicate.isString(value.$ref) &&
    value.$ref.startsWith("#/$defs/")
  ) {
    const name = decodeURIComponent(value.$ref.slice("#/$defs/".length))
      .replace(/~1/gu, "/")
      .replace(/~0/gu, "~");

    const target = context.definitions[name];

    if (context.seen.has(name) || target === undefined) return Option.some(name);

    return Option.some(
      schemaSummary(target, { ...context, seen: new Set([...context.seen, name]) })
    );
  }

  return Option.none();
};

const literalSummary = (schema: JsonSchema.JsonSchema): Option.Option<string> => {
  if ("const" in schema) return Option.some(JSON.stringify(schema.const));

  return Array.isArray(schema.enum) ? Option.some(enumSummary(schema.enum)) : Option.none();
};

const schemaSummary = (value: unknown, context: SummaryContext): string => {
  const reference = referenceSummary(value, context);

  if (Option.isSome(reference)) return reference.value;

  if (!Predicate.isObject(value)) return JSON.stringify(value);
  const literal = literalSummary(value);

  if (Option.isSome(literal)) return literal.value;
  const composite = compositeSummary(value, context);

  if (composite !== "") return composite;

  if (Predicate.isObject(value.properties)) {
    return objectSummary(
      value.properties,
      Array.isArray(value.required) ? value.required : [],
      context
    );
  }

  return value.type === "array"
    ? `Array<${schemaSummary(value.items, context)}>`
    : scalarSummary(value);
};

const compactHomogeneousArray = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (
    schema.type === "array" &&
    Array.isArray(schema.prefixItems) &&
    schema.prefixItems.length === 1 &&
    schema.items !== undefined &&
    JSON.stringify(schema.prefixItems[0]) === JSON.stringify(schema.items)
  ) {
    const { prefixItems: _prefixItems, ...homogeneous } = schema;

    return homogeneous;
  }

  return schema;
};

const constraintDescription = (
  schema: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions
): string =>
  ["$ref", "const", "pattern", "anyOf", "oneOf", "allOf"].some((key) => key in schema)
    ? `Shape: ${schemaSummary(schema, { definitions, seen: new Set() })}`
    : "";

const compactNumericBounds = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
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

  const minimum = bounds.flatMap((bound) =>
    Predicate.isNumber(bound.minimum) ? [bound.minimum] : []
  );

  const maximum = bounds.flatMap((bound) =>
    Predicate.isNumber(bound.maximum) ? [bound.maximum] : []
  );

  const { allOf: _allOf, ...scalar } = schema;
  const bounded: JsonSchema.JsonSchema = { ...scalar };

  if (minimum.length > 0) bounded.minimum = Math.max(...minimum);

  if (maximum.length > 0) bounded.maximum = Math.min(...maximum);

  return bounded;
};

const compactNode = (
  value: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
  describe = true
): JsonSchema.JsonSchema => {
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
              Predicate.isObject(node) ? compactNode(node, definitions, describeChildren) : node,
            ])
          ),
        ];
      }

      if (schemaArrays.has(key) && Array.isArray(child)) {
        return [
          key,
          child.map((node) =>
            Predicate.isObject(node) ? compactNode(node, definitions, describeChildren) : node
          ),
        ];
      }

      return [
        key,
        schemaNodes.has(key) && Predicate.isObject(child)
          ? compactNode(child, definitions, describeChildren)
          : child,
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
