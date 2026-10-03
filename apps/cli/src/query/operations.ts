import { type PATScope, decideOperationAccess, operationCatalog } from "@fidy/server/client";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliFailure, type Credential } from "../credential/contract";
import type { QueryDependencies, QueryResult } from "./contract";

const eligibleQuery = (id: string, scopes: ReadonlyArray<PATScope>): boolean => {
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined) return false;
  return (
    operation.policy.kind === "query" &&
    decideOperationAccess(operation.policy.access, { _tag: "PAT", capabilities: scopes })._tag ===
      "Allowed"
  );
};

type QueryDescription = Readonly<{
  id: string;
  description: string;
  requiresInput: boolean;
  input: ReturnType<typeof Schema.toJsonSchemaDocument>;
  output: ReturnType<typeof Schema.toJsonSchemaDocument>;
}>;

/** Saved capabilities select presentation only; each invocation still requires live server authority. */
export const discoverQueries = (scopes: ReadonlyArray<PATScope>): ReadonlyArray<QueryDescription> =>
  operationCatalog.operations
    .filter((operation) => eligibleQuery(operation.id, scopes))
    .map((operation) => ({
      id: operation.id,
      description: operation.description,
      requiresInput: Option.isSome(operation.partialInput),
      input: Schema.toJsonSchemaDocument(operation.input),
      output: Schema.toJsonSchemaDocument(operation.success),
    }));

const loadCredential = Effect.fn(function* (dependencies: QueryDependencies) {
  const saved = yield* dependencies.store.load;
  if (Option.isNone(saved)) return yield* new CliFailure({ reason: "LoginRequired" });
  const now = yield* DateTime.now;
  if (saved.value.grant.pat.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
    return yield* new CliFailure({ reason: "Expired" });
  }
  return saved.value;
});

/** Invokes one eligible query without retries, returning only canonical encoded data and safe metadata. */
export const invokeQuery = Effect.fn(function* (
  options: Readonly<{
    id: string;
    input: unknown;
    credential: Credential;
    httpClient: QueryDependencies["httpClient"];
    clientFactory: QueryDependencies["clientFactory"];
  }>
) {
  const { id, input, credential } = options;
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined || !eligibleQuery(id, credential.grant.pat.scopes)) {
    return yield* new CliFailure({ reason: "QueryUnavailable" });
  }
  const decoded = yield* Schema.decodeUnknownEffect(operation.input, {
    errors: "all",
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new CliFailure({ reason: "InvalidInput" })));
  let retryAfterSeconds = Option.none<number>();
  const client = yield* options.clientFactory({
    httpClient: options.httpClient,
    credential,
    captureRetry: (seconds) => {
      retryAfterSeconds = Option.some(seconds);
    },
  });
  const separator = id.indexOf(".");
  const group = id.slice(0, separator);
  const name = id.slice(separator + 1);
  const call = client[group]?.[name];
  if (call === undefined) return yield* new CliFailure({ reason: "QueryUnavailable" });
  const result = yield* Effect.result(call(decoded));
  const failed = result._tag === "Failure";
  const envelope = yield* Schema.encodeUnknownEffect(
    failed ? operation.failure : operation.success
  )(failed ? result.failure : result.success).pipe(
    Effect.mapError(() => new CliFailure({ reason: "TransportUnavailable" }))
  );
  const output: QueryResult = { envelope, failed, retryAfterSeconds };
  return output;
});

const radix = 16;
const terminalSafe = (text: string): string =>
  text.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(radix).padStart(4, "0")}`
  );
const encodeJson = (value: unknown): string =>
  Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json))(value);

/** Canonical JSON remains parseable while JSON escaping neutralizes terminal and bidi controls. */
export const formatQueryResult = ({
  result,
  json,
}: Readonly<{ result: QueryResult; json: boolean }>): string => {
  const encoded = terminalSafe(encodeJson(result.envelope));
  return json
    ? `${encoded}\n`
    : `${result.failed ? "La consulta fue rechazada." : "Resultado de la consulta:"}\n${encoded}\n`;
};

const failureGuidance = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const suggestedGuidance = Schema.Struct({
  next: Schema.Array(Schema.Struct({ tool: Schema.String, hint: Schema.String })),
});
const showFailureGuidance = Effect.fn(function* (
  result: QueryResult,
  dependencies: QueryDependencies
) {
  if (Option.isSome(result.retryAfterSeconds)) {
    yield* dependencies.stderr(
      `El servidor indica esperar ${result.retryAfterSeconds.value} segundos; no se reintenta automáticamente.\n`
    );
  }
  const failure = Schema.decodeUnknownOption(failureGuidance)(result.envelope);
  if (Option.isNone(failure)) return;
  const code = failure.value.error.code;
  if (code === "unauthenticated") {
    yield* dependencies.stderr(
      "El acceso puede estar vencido o revocado. Revisa fidy status y el permiso en la web; usa logout y login si necesitas otro permiso.\n"
    );
  }
  if (code === "user_action_required" || code === "consent_required") {
    yield* dependencies.stderr(
      "Revisa y restaura el Consentimiento en la aplicación web antes de continuar.\n"
    );
  }
});
const showSuggestions = Effect.fn(function* (
  result: QueryResult,
  credential: Credential,
  dependencies: QueryDependencies
) {
  const suggestions = Schema.decodeUnknownOption(suggestedGuidance)(result.envelope);
  if (Option.isNone(suggestions)) return;
  for (const suggestion of suggestions.value.next) {
    if (!eligibleQuery(suggestion.tool, credential.grant.pat.scopes)) continue;
    yield* dependencies.stderr(
      terminalSafe(
        encodeJson(
          `Posible siguiente consulta: fidy ${suggestion.tool.replace(".", " ")}. ${suggestion.hint} Los argumentos sugeridos son parciales; revisa --help. No se ejecuta automáticamente.`
        )
      ) + "\n"
    );
  }
});

const readInput = Effect.fn(function* (
  args: ReadonlyArray<string>,
  command: QueryDescription,
  dependencies: QueryDependencies
) {
  if (args.length === 2 && !command.requiresInput) return {};
  const path = args[3];
  if (args.length !== 4 || args[2] !== "--input" || path === undefined || !command.requiresInput) {
    return yield* new CliFailure({ reason: "InvalidInput" });
  }
  return yield* dependencies.readInput(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
    Effect.mapError((failure) =>
      failure instanceof CliFailure ? failure : new CliFailure({ reason: "InvalidInput" })
    )
  );
});

const maximumArguments = 4;
const maximumArgumentCharacters = 256;
const Arguments = Schema.Array(
  Schema.NonEmptyString.check(Schema.isMaxLength(maximumArgumentCharacters))
).check(Schema.isMaxLength(maximumArguments));

/** Generic group/operation parser, input decoding, derived execution and channel-separated presentation. */
export const runQueryCommand = Effect.fn(function* (
  inputArgs: unknown,
  dependencies: QueryDependencies
) {
  const args = yield* Schema.decodeUnknownEffect(Arguments)(inputArgs).pipe(
    Effect.mapError(() => new CliFailure({ reason: "InvalidInput" }))
  );
  const credential = yield* loadCredential(dependencies);
  const catalog = discoverQueries(credential.grant.pat.scopes);
  if (args.length === 1 && (args[0] === "commands" || args[0] === "--help")) {
    yield* dependencies.stdout(
      dependencies.json
        ? terminalSafe(encodeJson({ commands: catalog })) + "\n"
        : "Consultas disponibles (permisos guardados; el servidor verifica cada llamada):\n" +
            catalog
              .map((command) => `${command.id.replace(".", " ")} — ${command.description}`)
              .join("\n") +
            "\n"
    );
    return false;
  }
  const id = `${args[0]}.${args[1]}`;
  const command = catalog.find((candidate) => candidate.id === id);
  if (command === undefined) return yield* new CliFailure({ reason: "QueryUnavailable" });
  if (args.length === 3 && args[2] === "--help") {
    yield* dependencies.stdout(terminalSafe(encodeJson(command)) + "\n");
    return false;
  }
  const input = yield* readInput(args, command, dependencies);
  const result = yield* invokeQuery({
    id,
    input,
    credential,
    httpClient: dependencies.httpClient,
    clientFactory: dependencies.clientFactory,
  });
  yield* dependencies.stdout(formatQueryResult({ result, json: dependencies.json }));
  yield* showFailureGuidance(result, dependencies);
  yield* showSuggestions(result, credential, dependencies);
  return result.failed;
});
