import { Context, Effect, Function, Layer, Option, Predicate, Schema, type Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";
import { Tool, Toolkit } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import type { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { type AgentBearerToken } from "~/core/tokens/model";
import { AgentAuthorization } from "~/shell/_shared/authz";
import { type CatalogOperation } from "~/shell/_shared/operation-catalog";
import { type AgentConfirmation } from "~/shell/_shared/operation-policy";
import { FidyApi, operationCatalog } from "~/shell/api";
import { Telemetry, encodeTraceParent } from "~/shell/observability/telemetry";

const maximumOpenAiToolNameLength = 64;

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
const httpProtocols = new Set(["http:", "https:"]);

const isLoopbackOrigin = (url: URL): boolean =>
  loopbackHostnames.has(url.hostname) && httpProtocols.has(url.protocol);

const carriesNoCredentials = (url: URL): boolean => url.username === "" && url.password === "";

const hasEmptyQueryAndFragment = (url: URL): boolean => url.search === "" && url.hash === "";

const addressesOriginRoot = (url: URL): boolean =>
  url.pathname === "/" && hasEmptyQueryAndFragment(url);

const safeCanonicalApiUrl = Schema.makeFilter<URL>((url) =>
  isLoopbackOrigin(url) && carriesNoCredentials(url) && addressesOriginRoot(url)
    ? undefined
    : "Expected a loopback canonical API origin without credentials"
);

/** Runtime-validated origin used by standalone canonical API clients. */
export const CanonicalApiUrl = Schema.URLFromString.check(safeCanonicalApiUrl);
export type CanonicalApiUrl = typeof CanonicalApiUrl.Type;

/**
 * Optional validated base URL for the canonical HTTP client. Test servers provide
 * a pre-addressed HttpClient; standalone adapters override this with their server.
 */
export const CanonicalApiBaseUrl = Context.Reference<Option.Option<CanonicalApiUrl>>(
  "fidy-ai/shell/agent/toolkit/CanonicalApiBaseUrl",
  { defaultValue: Option.none }
);

/** OpenAI-compatible alias mechanically derived from a canonical operation id. */
export const OpenAiToolName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(maximumOpenAiToolNameLength)
).pipe(Schema.brand("OpenAiToolName"));
export type OpenAiToolName = typeof OpenAiToolName.Type;

/**
 * Connects one provider-safe tool to its canonical operation declaration. `canonicalParameters`
 * governs API input, while `providerResponseParameters` accepts either strict OpenAI arguments or
 * the canonical encoded form returned by Effect's provider adapter. `wireJsonSchema` is the exact
 * strict schema published to OpenAI and must remain paired with that response codec.
 */
export type AgentOperationBinding = {
  readonly operation: CanonicalOperationId;
  readonly wireName: OpenAiToolName;
  readonly description: string;
  readonly canonicalParameters: CatalogOperation["input"];
  readonly providerResponseParameters: Schema.Codec<unknown, unknown, never, never>;
  readonly wireJsonSchema: ReturnType<typeof toCodecOpenAI>["jsonSchema"];
  readonly success: CatalogOperation["success"];
  readonly failure: CatalogOperation["failure"];
  readonly policy: CatalogOperation["policy"];
};

/** Encodes a canonical dot without changing any other operation identity text. */
export const encodeOpenAiToolName = (operation: CanonicalOperationId): OpenAiToolName =>
  OpenAiToolName.make(operation.replaceAll(".", "__"));

/** Every hosted tool binding, derived from the assembled FidyApi catalog. */
export const agentOperationBindings: ReadonlyArray<AgentOperationBinding> =
  operationCatalog.operations.map((operation) => {
    const { codec: wireCodec, jsonSchema: wireJsonSchema } = toCodecOpenAI(operation.input);
    const wireParameters: Schema.Codec<unknown, unknown, never, never> = Schema.make(wireCodec.ast);
    const providerResponseParameters: Schema.Codec<unknown, unknown, never, never> = Schema.Union([
      wireParameters,
      operation.input,
    ]);
    return {
      operation: operation.id,
      wireName: encodeOpenAiToolName(operation.id),
      description: operation.description,
      canonicalParameters: operation.input,
      providerResponseParameters,
      wireJsonSchema,
      success: operation.success,
      failure: operation.failure,
      policy: operation.policy,
    };
  });

const bindingsByWireName = new Map(
  agentOperationBindings.map((binding) => [binding.wireName, binding] as const)
);
if (bindingsByWireName.size !== agentOperationBindings.length) {
  throw new Error("Canonical operation aliases must remain unique for OpenAI");
}

/** Finds the canonical binding for one provider-safe tool name. */
export const findAgentOperationBinding = (
  wireName: string
): Option.Option<AgentOperationBinding> =>
  Schema.is(OpenAiToolName)(wireName)
    ? Option.fromNullishOr(bindingsByWireName.get(wireName))
    : Option.none();

const confirmationGuidance = (agentConfirmation: AgentConfirmation): string =>
  agentConfirmation === "not-required"
    ? " This operation does not require User confirmation; call it directly without asking the User to confirm."
    : " The host manages exact confirmation for this operation; call the tool rather than asking the User for informal confirmation.";

/** Decodes a provider-safe tool input into the canonical operation input type. */
export const decodeAgentOperationInput: {
  (input: unknown): (self: AgentOperationBinding) => Effect.Effect<unknown, Schema.SchemaError>;
  (self: AgentOperationBinding, input: unknown): Effect.Effect<unknown, Schema.SchemaError>;
} = Function.dual(2, (self: AgentOperationBinding, input: unknown) =>
  Schema.decodeUnknownEffect(self.providerResponseParameters)(input)
);

const tools = agentOperationBindings.map((binding) =>
  Tool.dynamic(binding.wireName, {
    description: binding.description + confirmationGuidance(binding.policy.agentConfirmation),
    parameters: Schema.toEncoded(binding.canonicalParameters),
    success: binding.success,
    failure: binding.failure,
    failureMode: "return",
  })
);

/** Toolkit definition containing exactly the operations reflected from FidyApi. */
export const AgentToolkit = Toolkit.make(...tools);

type DynamicOperation = (input: unknown) => Effect.Effect<unknown, object, never>;

const isDynamicOperation = (value: unknown): value is DynamicOperation =>
  typeof value === "function";

const callOperation = (
  client: object,
  binding: AgentOperationBinding,
  input: unknown
): Effect.Effect<unknown, object> => {
  const separator = binding.operation.indexOf(".");
  const groupName = binding.operation.slice(0, separator);
  const operationName = binding.operation.slice(separator + 1);
  if (!Predicate.hasProperty(client, groupName)) {
    return Effect.die(new Error("Derived canonical API client group is missing"));
  }
  const group = client[groupName];
  if (typeof group !== "object" || group === null || !Predicate.hasProperty(group, operationName)) {
    return Effect.die(new Error("Derived canonical API client operation is missing"));
  }
  const operation = group[operationName];
  if (!isDynamicOperation(operation)) {
    return Effect.die(new Error("Derived canonical API client operation is not callable"));
  }
  return operation(input).pipe(
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.catch((error) =>
      Schema.is(binding.failure)(error)
        ? Effect.fail(error)
        : Effect.die(new Error("Canonical API client returned an undeclared failure"))
    )
  );
};

/**
 * Binds the derived toolkit to a turn-scoped AgentToken. Each handler restores
 * the canonical id and calls the generated HTTP client through AgentAuthorization.
 */
export const makeAgentToolkit = (
  bearer: AgentBearerToken
): Effect.Effect<
  Toolkit.WithHandler<typeof AgentToolkit.tools>,
  never,
  HttpClient.HttpClient | Scope.Scope | Telemetry
> =>
  Effect.gen(function* () {
    const baseUrl = yield* CanonicalApiBaseUrl;
    const telemetry = yield* Telemetry;
    const authorization = HttpApiMiddleware.layerClient(AgentAuthorization, ({ next, request }) =>
      Effect.flatMap(telemetry.captureDurableContext, (context) => {
        const authorized = HttpClientRequest.bearerToken(request, bearer);
        return next(
          Option.match(context, {
            onNone: () => authorized,
            onSome: (coordinates) =>
              HttpClientRequest.setHeader(
                authorized,
                "traceparent",
                encodeTraceParent(coordinates)
              ),
          })
        );
      })
    );
    const middlewareContext = yield* Layer.build(authorization);
    const derivedClient = Option.match(baseUrl, {
      onNone: () => HttpApiClient.make(FidyApi),
      onSome: (url) => HttpApiClient.make(FidyApi, { baseUrl: url.href }),
    });
    const client = yield* derivedClient.pipe(Effect.provide(middlewareContext));
    const handlers = Object.fromEntries(
      agentOperationBindings.map((binding) => [
        binding.wireName,
        (input: unknown): Effect.Effect<unknown, object> =>
          Schema.decodeUnknownEffect(binding.canonicalParameters)(input).pipe(
            Effect.orDie,
            Effect.flatMap((canonicalInput) => callOperation(client, binding, canonicalInput))
          ),
      ])
    );
    const handlerContext = yield* AgentToolkit.toHandlers(handlers);
    return yield* AgentToolkit.pipe(Effect.provide(handlerContext));
  });
