import { type JsonSchema, Option, Predicate, Schema } from "effect";

type Document = JsonSchema.Document<"draft-2020-12">;
export type ScalarFlag = Readonly<{
  name: string;
  path: ReadonlyArray<string>;
  required: boolean;
  constraints: JsonSchema.JsonSchema;
  type: "string" | "number" | "integer" | "boolean";
}>;
export type FlagPlan = Readonly<{
  flags: ReadonlyArray<ScalarFlag>;
  structured: ReadonlyArray<Readonly<{ path: ReadonlyArray<string>; required: boolean }>>;
  containers: ReadonlyArray<ReadonlyArray<string>>;
}>;
const reserved = new Set(["input", "help", "json"]);
const transport = new Set(["payload", "query", "params", "headers"]);
const maximumDepth = 8;
const maximumFlags = 24;
const kebabCase = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
const Properties = Schema.Record(Schema.String, Schema.Unknown);
const Required = Schema.Array(Schema.String);
const constrainedText = (node: JsonSchema.JsonSchema): boolean =>
  node.enum !== undefined ||
  node.format !== undefined ||
  (Predicate.isString(node.pattern) &&
    !node.pattern.includes("\\S") &&
    !node.pattern.includes("\\s"));
const nullableScalar = (node: JsonSchema.JsonSchema): Option.Option<JsonSchema.JsonSchema> => {
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2) return Option.none();
  const members = node.anyOf.filter(Predicate.isObject);
  if (!members.some((member) => member.type === "null")) return Option.none();
  return Option.fromUndefinedOr(members.find((member) => member.type !== "null"));
};
const scalarType = (node: JsonSchema.JsonSchema): Option.Option<ScalarFlag["type"]> => {
  const nullable = nullableScalar(node);
  if (Option.isSome(nullable)) return scalarType(nullable.value);
  switch (node.type) {
    case "string":
      return constrainedText(node) ? Option.some("string") : Option.none();
    case "number":
    case "integer":
    case "boolean":
      return Option.some(node.type);
    default:
      return Option.none();
  }
};
type Candidate = { flag: ScalarFlag; parts: ReadonlyArray<string>; width: number };
const candidateName = ({ parts, width }: Candidate): string =>
  parts.slice(-width).map(kebabCase).join("-");
const extendName = (candidate: Candidate): boolean => {
  if (candidate.width < candidate.parts.length) candidate.width += 1;
  else if (candidate.parts.length < candidate.flag.path.length) {
    candidate.parts = candidate.flag.path;
    candidate.width = candidate.parts.length;
  } else return false;
  return true;
};
const nameFlags = (flags: ReadonlyArray<ScalarFlag>): ReadonlyArray<ScalarFlag> => {
  const candidates: Candidate[] = flags.map((flag) => ({
    flag,
    parts: flag.path.filter((part, index) => index !== 0 || !transport.has(part)),
    width: 1,
  }));
  for (let round = 0; round <= maximumDepth; round += 1) {
    const names = candidates.map(candidateName);
    const collisions = candidates.filter((candidate) => {
      const name = candidateName(candidate);
      return reserved.has(name) || names.filter((other) => other === name).length > 1;
    });
    if (collisions.length === 0) {
      return candidates.map((candidate) => ({ ...candidate.flag, name: candidateName(candidate) }));
    }
    if (!collisions.every(extendName)) return [];
  }
  return [];
};

// Reflection stays on the deliberate encoded JSON document, never a foreign private AST.
export const deriveFlags = (document: Document): FlagPlan => {
  const flags: ScalarFlag[] = [];
  const structured: { path: ReadonlyArray<string>; required: boolean }[] = [];
  const containers: ReadonlyArray<string>[] = [];
  const visit = (
    node: JsonSchema.JsonSchema,
    location: Readonly<{ path: ReadonlyArray<string>; required: boolean; depth: number }>
  ): void => {
    const { path, required, depth } = location;
    if (depth > maximumDepth) {
      structured.push({ path, required });
      return;
    }
    if (Predicate.isString(node.$ref)) {
      const target = document.definitions[node.$ref.replace(/^#\/\$defs\//u, "")];
      if (target !== undefined) {
        const { $ref: _reference, ...annotations } = node;
        return visit({ ...target, ...annotations }, { ...location, depth: depth + 1 });
      }
    }
    if (node.type === "object") {
      visitObject(node, location);
      return;
    }
    const type = scalarType(node);
    if (Option.isNone(type)) structured.push({ path, required });
    else flags.push({ name: "", path, required, constraints: node, type: type.value });
  };
  const visitObject = (
    node: JsonSchema.JsonSchema,
    location: Readonly<{ path: ReadonlyArray<string>; required: boolean; depth: number }>
  ): void => {
    if (node.properties === undefined) return;
    if (location.required && location.path.length > 0) containers.push(location.path);
    const properties = Schema.decodeUnknownSync(Properties)(node.properties);
    const requiredKeys = Schema.decodeUnknownSync(Required)(node.required ?? []);
    for (const [key, child] of Object.entries(properties)) {
      if (Predicate.isObject(child)) {
        visit(child, {
          path: [...location.path, key],
          required: location.required && requiredKeys.includes(key),
          depth: location.depth + 1,
        });
      }
    }
  };
  visit(document.schema, { path: [], required: true, depth: 0 });
  const named = flags.length > maximumFlags ? [] : nameFlags(flags);
  if (named.length !== flags.length) {
    return { flags: [], structured: [{ path: [], required: true }], containers };
  }
  return { flags: named, structured, containers };
};

export const flagHelp =
  "Usa --nombre valor (booleanos: true/false); nombres únicos en kebab-case, colisiones con el padre más cercano. Máximo 24 escalares, profundidad 8. Strings con enum, format o pattern sin clases de espacio; texto libre, arrays y uniones requieren --input archivo.json o --input -. No pongas información sensible en el historial del shell. No se permite mezclar --input y flags, duplicados, nombres desconocidos ni --nombre=valor. El esquema completo valida requisitos, defaults y restricciones; revisa constraints y structured.";

export const assembleFlags = ({
  args,
  plan,
}: Readonly<{ args: ReadonlyArray<string>; plan: FlagPlan }>): unknown => {
  if (args.length % 2 !== 0 || plan.structured.some((field) => field.required)) {
    throw new Error("Structured input required");
  }
  const supplied = new Map<string, unknown>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    const flag = plan.flags.find((candidate) => `--${candidate.name}` === name);
    if (flag === undefined || value === undefined || supplied.has(flag.name)) {
      throw new Error("Invalid flags");
    }
    const parsed =
      flag.type === "string" ? value : Schema.decodeSync(Schema.fromJsonString(Schema.Json))(value);
    supplied.set(flag.name, parsed);
  }
  const build = (path: ReadonlyArray<string>): unknown => {
    const scalar = plan.flags.find((flag) => flag.path.join(".") === path.join("."));
    if (scalar !== undefined) return supplied.get(scalar.name);
    const activePaths = [
      ...plan.containers,
      ...plan.flags.filter((flag) => supplied.has(flag.name)).map((flag) => flag.path),
    ];
    const keys = new Set(
      activePaths
        .filter(
          (candidate) =>
            candidate.length > path.length && path.every((part, index) => candidate[index] === part)
        )
        .map((candidate) => candidate[path.length])
    );
    return Object.fromEntries(
      [...keys].filter(Predicate.isString).map((key) => [key, build([...path, key])])
    );
  };
  return build([]);
};
