import {
  type CanonicalAllowance,
  type PATScope,
  atomicBatchChildOperations,
  atomicBatchOperation,
  decideOperationAccess,
  getAtomicBatchInputSchema,
  operationCatalog,
  projectAtomicBatchSchemas,
} from "@fidy/server/client";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliFailure, type Credential } from "../credential/contract";
import { formatFailure } from "../command/operations";
import type { CanonicalDependencies, OperationResult } from "./contract";
import { type FlagPlan, assembleFlags, deriveFlags, flagHelp } from "./internal/flags";

const eligibleOperation = (id: string, scopes: ReadonlyArray<PATScope>): boolean => {
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined) return false;
  return (
    (operation.id !== atomicBatchOperation ||
      atomicBatchChildOperations(operationCatalog).some((child) =>
        eligibleOperation(child.id, scopes)
      )) &&
    decideOperationAccess(operation.policy.access, { _tag: "PAT", capabilities: scopes })._tag ===
      "Allowed"
  );
};

type OperationDescription = Readonly<{
  id: string;
  description: string;
  policy: (typeof operationCatalog.operations)[number]["policy"];
  requiresInput: boolean;
  flags: FlagPlan["flags"];
  structured: FlagPlan["structured"];
  flagHelp: string;
  input: ReturnType<typeof Schema.toJsonSchemaDocument>;
  output: ReturnType<typeof Schema.toJsonSchemaDocument>;
}>;

/** Saved capabilities select presentation only; each invocation still requires live server authority. */
export const discoverOperations = (
  scopes: ReadonlyArray<PATScope>
): ReadonlyArray<OperationDescription> =>
  operationCatalog.operations
    .filter((operation) => eligibleOperation(operation.id, scopes))
    .map((operation) => {
      const schemas =
        operation.id === atomicBatchOperation
          ? projectAtomicBatchSchemas({
              catalog: operationCatalog,
              includeChild: (child) => eligibleOperation(child.id, scopes),
            })
          : { input: operation.input, output: operation.success };
      const input = Schema.toJsonSchemaDocument(schemas.input);
      const plan = deriveFlags(input);
      return {
        id: operation.id,
        description: operation.description,
        policy: operation.policy,
        requiresInput: Option.isSome(operation.partialInput),
        flags: plan.flags,
        structured: plan.structured,
        flagHelp,
        input,
        output: Schema.toJsonSchemaDocument(schemas.output),
      };
    });

const loadCredential = Effect.fn(function* (dependencies: CanonicalDependencies) {
  const saved = yield* dependencies.store.load;
  if (Option.isNone(saved)) return yield* new CliFailure({ reason: "LoginRequired" });
  const now = yield* DateTime.now;
  if (saved.value.grant.pat.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
    return yield* new CliFailure({ reason: "Expired" });
  }
  return saved.value;
});

const decodeInput = Effect.fn(function* (
  operation: (typeof operationCatalog.operations)[number],
  input: unknown,
  scopes: ReadonlyArray<PATScope>
) {
  const decoded = yield* Schema.decodeUnknownEffect(operation.input, {
    errors: "all",
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new CliFailure({ reason: "InvalidInput" })));
  if (operation.id === atomicBatchOperation) {
    // Reuse the owning ordered child union, not a CLI-owned subset or alternate batch contract.
    const batch = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ payload: getAtomicBatchInputSchema() }),
      { errors: "all", onExcessProperty: "error" }
    )(input).pipe(Effect.mapError(() => new CliFailure({ reason: "InvalidInput" })));
    for (const child of batch.payload.calls) {
      if (!eligibleOperation(child.operation, scopes)) {
        return yield* new CliFailure({ reason: "OperationUnavailable" });
      }
    }
  }
  return decoded;
});

/** Invokes one eligible operation without retries, returning only canonical encoded data and safe metadata. */
export const invokeOperation = Effect.fn(function* (
  options: Readonly<{
    id: string;
    input: unknown;
    credential: Credential;
    httpClient: CanonicalDependencies["httpClient"];
    clientFactory: CanonicalDependencies["clientFactory"];
    stderr: CanonicalDependencies["stderr"];
    json: boolean;
  }>
) {
  const { id, input, credential } = options;
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined || !eligibleOperation(id, credential.grant.pat.scopes)) {
    return yield* new CliFailure({ reason: "OperationUnavailable" });
  }
  const decoded = yield* decodeInput(operation, input, credential.grant.pat.scopes);
  let retryAfterSeconds = Option.none<number>();
  let allowance = Option.none<CanonicalAllowance>();
  const client = yield* options.clientFactory({
    httpClient: options.httpClient,
    credential,
    captureRetry: (seconds) => {
      retryAfterSeconds = Option.some(seconds);
    },
    captureAllowance: (standing) => {
      allowance = standing;
    },
  });
  const separator = id.indexOf(".");
  const group = id.slice(0, separator);
  const name = id.slice(separator + 1);
  const call = client[group]?.[name];
  if (call === undefined) return yield* new CliFailure({ reason: "OperationUnavailable" });
  const uncertainReason =
    operation.policy.kind === "mutation" ? "MutationAmbiguous" : "TransportUnavailable";
  const result = yield* call(decoded).pipe(
    Effect.catchDefect(() => Effect.fail(new CliFailure({ reason: uncertainReason }))),
    Effect.onInterrupt(() =>
      operation.policy.kind === "mutation"
        ? options.stderr(formatFailure({ reason: "MutationAmbiguous", json: options.json }))
        : Effect.void
    ),
    Effect.result
  );
  const failed = result._tag === "Failure";
  const envelope = yield* Schema.encodeUnknownEffect(
    failed ? operation.failure : operation.success
  )(failed ? result.failure : result.success).pipe(
    Effect.mapError(() => new CliFailure({ reason: uncertainReason }))
  );
  const output: OperationResult = { envelope, failed, retryAfterSeconds, allowance };
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
export const formatOperationResult = ({
  result,
  json,
}: Readonly<{ result: OperationResult; json: boolean }>): string => {
  const encoded = terminalSafe(encodeJson(result.envelope));
  return json
    ? `${encoded}\n`
    : `${result.failed ? "La operación devolvió un fallo:" : "Resultado de la operación:"}\n${encoded}\n`;
};

const failureGuidance = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const batchRejectionGuidance = Schema.Struct({
  error: Schema.Struct({ failedCallIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
});
const showBatchRejection = (
  id: string,
  result: OperationResult,
  dependencies: CanonicalDependencies
): Effect.Effect<void> =>
  id === atomicBatchOperation &&
  result.failed &&
  Option.isSome(Schema.decodeUnknownOption(batchRejectionGuidance)(result.envelope))
    ? dependencies.stderr(
        "El lote fue rechazado; sus cambios de dominio no se confirmaron. La evidencia de rechazo del servidor puede conservarse. Revisa el hijo indicado y sus permisos antes de enviar un lote corregido.\n"
      )
    : Effect.void;
const suggestedGuidance = Schema.Struct({
  next: Schema.Array(Schema.Struct({ tool: Schema.String, hint: Schema.String })),
});
const showAllowance = (
  result: OperationResult,
  dependencies: CanonicalDependencies
): Effect.Effect<void> => {
  if (Option.isNone(result.allowance)) {
    return dependencies.stderr(
      "Información de llamadas canónicas no disponible; no se estima un saldo local.\n"
    );
  }
  const meter = result.allowance.value;
  return dependencies.stderr(
    meter.limit === "uncapped"
      ? "El servidor indica acceso sin medidor comercial mensual; siguen aplicando las protecciones de solicitudes y seguridad.\n"
      : `${meter.remaining} de ${meter.limit} llamadas canónicas restantes, compartidas por todos tus PAT. Reinicio: ${DateTime.formatIso(meter.resetsAt)} (UTC).\n`
  );
};
const allowanceFailureCode = Schema.Literals([
  "quota_exhausted",
  "rate_limited",
  "paywall_required",
]);
const allowanceFailureGuidance: Readonly<Record<typeof allowanceFailureCode.Type, string>> = {
  quota_exhausted:
    "La capacidad sigue siendo Free; espera el reinicio exacto indicado por el servidor o revisa las siguientes operaciones permitidas. No se reintenta automáticamente.\n",
  rate_limited:
    "Es una protección de solicitudes o seguridad, no agotamiento del cupo comercial. Respeta Retry-After cuando esté disponible.\n",
  paywall_required: "Esta capacidad requiere Pro; revisa las siguientes operaciones permitidas.\n",
};
const showFailureGuidance = Effect.fn(function* (
  result: OperationResult,
  dependencies: CanonicalDependencies
) {
  if (Option.isSome(result.retryAfterSeconds)) {
    yield* dependencies.stderr(
      `El servidor indica esperar ${result.retryAfterSeconds.value} segundos; no se reintenta automáticamente.\n`
    );
  }
  const failure = Schema.decodeUnknownOption(failureGuidance)(result.envelope);
  if (Option.isNone(failure)) return;
  const code = failure.value.error.code;
  const allowanceCode = Schema.decodeUnknownOption(allowanceFailureCode)(code);
  if (Option.isSome(allowanceCode)) {
    yield* dependencies.stderr(allowanceFailureGuidance[allowanceCode.value]);
  }
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
  result: OperationResult,
  credential: Credential,
  dependencies: CanonicalDependencies
) {
  const suggestions = Schema.decodeUnknownOption(suggestedGuidance)(result.envelope);
  if (Option.isNone(suggestions)) return;
  for (const suggestion of suggestions.value.next) {
    if (!eligibleOperation(suggestion.tool, credential.grant.pat.scopes)) continue;
    yield* dependencies.stderr(
      terminalSafe(
        encodeJson(
          `Posible siguiente operación: fidy ${suggestion.tool.replace(".", " ")}. ${suggestion.hint} Los argumentos sugeridos son parciales; revisa --help. No se ejecuta automáticamente.`
        )
      ) + "\n"
    );
  }
});

const readInput = Effect.fn(function* (
  args: ReadonlyArray<string>,
  command: OperationDescription,
  dependencies: CanonicalDependencies
) {
  if (!args.slice(2).includes("--input")) {
    return yield* Effect.try({
      try: () => assembleFlags({ args: args.slice(2), plan: deriveFlags(command.input) }),
      catch: () => new CliFailure({ reason: "InvalidInput" }),
    });
  }
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

const maximumArguments = 50;
const maximumArgumentCharacters = 256;
const Arguments = Schema.Array(
  Schema.String.check(Schema.isMaxLength(maximumArgumentCharacters))
).check(Schema.isMaxLength(maximumArguments));

/** Generic group/operation parser, input decoding, derived execution and channel-separated presentation. */
export const runOperationCommand = Effect.fn(function* (
  inputArgs: unknown,
  dependencies: CanonicalDependencies
) {
  const args = yield* Schema.decodeUnknownEffect(Arguments)(inputArgs).pipe(
    Effect.mapError(() => new CliFailure({ reason: "InvalidInput" }))
  );
  const credential = yield* loadCredential(dependencies);
  const catalog = discoverOperations(credential.grant.pat.scopes);
  if (args.length === 1 && (args[0] === "commands" || args[0] === "--help")) {
    yield* dependencies.stdout(
      dependencies.json
        ? terminalSafe(encodeJson({ commands: catalog })) + "\n"
        : "Operaciones disponibles (permisos guardados; el servidor verifica cada llamada):\n" +
            catalog
              .map((command) => `${command.id.replace(".", " ")} — ${command.description}`)
              .join("\n") +
            "\n"
    );
    return false;
  }
  const id = `${args[0]}.${args[1]}`;
  const command = catalog.find((candidate) => candidate.id === id);
  if (command === undefined) return yield* new CliFailure({ reason: "OperationUnavailable" });
  if (args.length === 3 && args[2] === "--help") {
    yield* dependencies.stdout(terminalSafe(encodeJson(command)) + "\n");
    return false;
  }
  const input = yield* readInput(args, command, dependencies);
  const result = yield* invokeOperation({
    id,
    input,
    credential,
    httpClient: dependencies.httpClient,
    clientFactory: dependencies.clientFactory,
    stderr: dependencies.stderr,
    json: dependencies.json,
  });
  yield* dependencies.stdout(formatOperationResult({ result, json: dependencies.json }));
  yield* showAllowance(result, dependencies);
  yield* showBatchRejection(id, result, dependencies);
  yield* showFailureGuidance(result, dependencies);
  yield* showSuggestions(result, credential, dependencies);
  return result.failed;
});
