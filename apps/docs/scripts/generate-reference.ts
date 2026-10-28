import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";

const artifact = Schema.Struct({
  openapi: Schema.String,
  info: Schema.JsonObject,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.JsonObject)),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.JsonObject) }),
});
const operation = Schema.Struct({
  operationId: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/u)
  ),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.Array(Schema.JsonObject),
  requestBody: Schema.optionalKey(Schema.JsonObject),
  responses: Schema.Record(Schema.String, Schema.JsonObject),
  "x-fidy-access": Schema.Struct({
    type: Schema.Literal("user-owned-agent-scoped"),
    scope: Schema.Struct({
      evaluation: Schema.Literals(["operation", "children"]),
      capability: Schema.optionalKey(Schema.Literals(["read", "write", "dashboard"])),
    }),
  }),
  "x-fidy-agent-confirmation": Schema.Literals(["required", "not-required"]),
  "x-fidy-operation-kind": Schema.Literals(["query", "mutation"]),
  "x-fidy-required-tier": Schema.Literals(["free", "pro"]),
});
type Operation = typeof operation.Type;
const args = process.argv.slice(2);
const argument = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name} value`);
  return resolve(value);
};
if (
  args.some((value, index) => index % 2 === 0 && !["--source", "--destination"].includes(value))
) {
  throw new Error("Usage: generate-reference.ts [--source FILE] [--destination DIRECTORY]");
}
const source = argument(
  "--source",
  new URL("../../server/contracts/openapi.json", import.meta.url).pathname
);
const destination = argument("--destination", new URL("..", import.meta.url).pathname);
const document = Schema.decodeUnknownSync(Schema.fromJsonString(artifact))(
  readFileSync(source, "utf8")
);
const allowed = Schema.Struct({ type: Schema.Literal("user-owned-agent-scoped") });
const discovered = Object.entries(document.paths)
  .flatMap(([path, methods]) =>
    Object.entries(methods).flatMap(([method, candidate]) =>
      Schema.is(allowed)(candidate["x-fidy-access"])
        ? [{ path, method, declaration: Schema.decodeUnknownSync(operation)(candidate) }]
        : []
    )
  )
  .sort((left, right) => left.declaration.operationId.localeCompare(right.declaration.operationId));
if (discovered.length === 0) {
  throw new Error("No customer operations found; refusing empty publication");
}

const publicIds = new Set(discovered.map((entry) => entry.declaration.operationId));
const operationAlternative = Schema.Struct({
  properties: Schema.Struct({ operation: Schema.Struct({ enum: Schema.Array(Schema.String) }) }),
});
const inaccessibleOperation = (value: Schema.Json): boolean =>
  Schema.is(operationAlternative)(value) &&
  value.properties.operation.enum.some((id) => !publicIds.has(id));
const projectSchema = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(projectSchema);
  if (!Schema.is(Schema.JsonObject)(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      (key === "anyOf" || key === "oneOf") && Schema.is(Schema.Array(Schema.Json))(child)
        ? child.filter((alternative) => !inaccessibleOperation(alternative)).map(projectSchema)
        : projectSchema(child),
    ])
  );
};
const published = discovered.map((entry) => ({
  ...entry,
  declaration: Schema.decodeUnknownSync(operation)(projectSchema(entry.declaration)),
}));

const references = (value: Schema.Json): ReadonlyArray<string> =>
  Array.from(
    JSON.stringify(value).matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)"/gu),
    (match) => {
      const name = match[1];
      if (!name || !/^[a-zA-Z0-9_]+$/u.test(name)) throw new Error("Unsupported schema reference");
      return name;
    }
  );
const schemas: Record<string, Schema.JsonObject> = {};
const pending = new Set(published.flatMap(({ declaration }) => references(declaration)));
for (const name of pending) {
  const schema = document.components.schemas[name];
  if (!Object.hasOwn(document.components.schemas, name)) throw new Error(`Missing schema: ${name}`);
  const projected = Schema.decodeUnknownSync(Schema.JsonObject)(projectSchema(schema));
  schemas[name] = projected;
  references(projected).forEach((reference) => pending.add(reference));
}
const fence = (value: Schema.Json): string =>
  `\n\n\`\`\`json\n${JSON.stringify(value, undefined, 2)}\n\`\`\`\n`;
const permission = (declaration: Operation): string =>
  declaration["x-fidy-access"].scope.evaluation === "children"
    ? "Se evalúan los permisos de cada operación del lote."
    : `Permiso: **${declaration["x-fidy-access"].scope.capability}**.`;
const page = (entry: (typeof published)[number]): string => {
  const { declaration, method, path } = entry;
  const id = declaration.operationId;
  return (
    `---\ntitle: ${id}\ndescription: Contrato, permisos y respuestas de ${id}.\n---\n\n` +
    `Referencia generada. Consulta las [guías](/) para explicaciones y ejemplos en español.\n\n` +
    `${declaration.description ?? ""}\n\n## Acceso\n\n${permission(declaration)}\n\n` +
    `Plan requerido: **${declaration["x-fidy-required-tier"]}**. Tipo: **${declaration["x-fidy-operation-kind"]}**.\n\n` +
    `Confirmación sensible: **${declaration["x-fidy-agent-confirmation"]}**. ` +
    "\n\n" +
    `## Interfaces\n\n- MCP: herramienta \`${id}\`; los argumentos exactos se descubren en tu cliente según tus permisos.\n` +
    `- CLI: \`fidy ${id.replace(".", " ")} --help\`.\n` +
    `- API: \`${method.toUpperCase()} https://api.fidyapp.com${path}\`.\n\n` +
    `## Parámetros HTTP\n${fence(declaration.parameters)}\n## Cuerpo HTTP\n` +
    (declaration.requestBody
      ? fence(declaration.requestBody)
      : "\nEsta operación no declara cuerpo HTTP.\n") +
    `\n## Respuestas y errores declarados\n${fence(declaration.responses)}\n` +
    `Los \`$ref\` se resuelven en [los esquemas](/referencia/esquemas) y en el [OpenAPI público](/reference/openapi.json).\n`
  );
};
const paths: Record<string, Record<string, Schema.Json>> = {};
for (const { path, method, declaration } of published) {
  paths[path] = { ...paths[path], [method]: { ...declaration, security: [{ agentBearer: [] }] } };
}
const publicDocument = {
  openapi: document.openapi,
  info: document.info,
  servers: [{ url: "https://api.fidyapp.com" }],
  paths,
  components: { schemas, securitySchemes: { agentBearer: { type: "http", scheme: "bearer" } } },
};
const contentDirectory = resolve(destination, "src/content/docs/reference");
const publicDirectory = resolve(destination, "public/reference");
const pages = published.map((entry) => ({
  name: entry.declaration.operationId,
  content: page(entry),
}));
rmSync(contentDirectory, { recursive: true, force: true });
mkdirSync(contentDirectory, { recursive: true });
mkdirSync(publicDirectory, { recursive: true });
mkdirSync(resolve(destination, "src/content/docs/referencia"), { recursive: true });
for (const entry of pages) {
  writeFileSync(resolve(contentDirectory, `${entry.name}.md`), entry.content);
}
writeFileSync(
  resolve(publicDirectory, "openapi.json"),
  `${JSON.stringify(publicDocument, undefined, 2)}\n`
);
writeFileSync(
  resolve(contentDirectory, "index.md"),
  `---\ntitle: Referencia de operaciones\ndescription: Contratos disponibles para tus propios agentes.\n---\n\nLos permisos efectivos dependen de tu conexión. Esta referencia no concede acceso.\n\n` +
    pages.map((entry) => `- [${entry.name}](/reference/${entry.name.toLowerCase()})`).join("\n") +
    "\n"
);
writeFileSync(
  resolve(destination, "src/content/docs/referencia/esquemas.md"),
  `---\ntitle: Esquemas del contrato\ndescription: Esquemas alcanzables desde las operaciones para agentes.\n---\n\nLos nombres de esquema corresponden al OpenAPI público.\n` +
    fence(schemas)
);
process.stdout.write(`Generated ${pages.length} customer operations.\n`);
