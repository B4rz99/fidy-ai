import { Context, Effect, Function, Layer, Option, Schema, type Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";
import { Tool, Toolkit } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import type { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { type TokenBearer } from "~/core/tokens/model";
import { TokenAuthorization } from "~/shell/_shared/authz";
import { type CatalogOperation } from "~/shell/_shared/operation-catalog";
import { type AgentConfirmation } from "~/shell/_shared/operation-policy";
import { FidyApi, type FidyApiGroups, type OperationId, operationCatalog } from "~/shell/api";
import { Telemetry, encodeTraceParent } from "~/shell/observability/telemetry";

const maximumOpenAiToolNameLength = 64;

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
const httpProtocols = new Set(["http:", "https:"]);

const isSafeCanonicalApiUrl = (url: URL): boolean =>
  [
    loopbackHostnames.has(url.hostname),
    httpProtocols.has(url.protocol),
    url.username === "",
    url.password === "",
    url.pathname === "/",
    url.search === "",
    url.hash === "",
  ].every(Boolean);

const safeCanonicalApiUrl = Schema.makeFilter<URL>((url) =>
  isSafeCanonicalApiUrl(url)
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
  "@fidy/server/shell/agent/toolkit/CanonicalApiBaseUrl",
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

/** Returns the complete provider-facing description, including required confirmation behavior. */
export const agentOperationToolDescription = (binding: AgentOperationBinding): string =>
  binding.description + confirmationGuidance(binding.policy.agentConfirmation);

const tools = agentOperationBindings.map((binding) =>
  Tool.dynamic(binding.wireName, {
    description: agentOperationToolDescription(binding),
    parameters: Schema.toEncoded(binding.canonicalParameters),
    success: binding.success,
    failure: binding.failure,
    failureMode: "return",
  })
);

/** Toolkit definition containing exactly the operations reflected from FidyApi. */
export const AgentToolkit = Toolkit.make(...tools);

type ClientOperation = (input: unknown) => Effect.Effect<unknown, object>;

const bindClientOperation = <Input, Success, Failure extends object>(
  binding: AgentOperationBinding,
  operation: (input: Input) => Effect.Effect<Success, Failure, never>
): ClientOperation => {
  const parameters = Schema.make<Schema.Codec<Input, unknown, never, never>>(
    binding.canonicalParameters.ast
  );
  return (input) =>
    Schema.decodeUnknownEffect(parameters)(input).pipe(
      Effect.orDie,
      Effect.flatMap(operation),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.catch((error) =>
        Schema.is(binding.failure)(error)
          ? Effect.fail(error)
          : Effect.die(new Error("Canonical API client returned an undeclared failure"))
      )
    );
};

const requireBinding = (operation: OperationId): AgentOperationBinding => {
  const catalogOperation = Option.getOrThrowWith(
    Option.fromNullishOr(operationCatalog.byId.get(operation)),
    () => new Error(`Agent operation binding is missing: ${operation}`)
  );
  const binding = agentOperationBindings.find(
    (candidate) => candidate.operation === catalogOperation.id
  );
  if (binding === undefined) throw new Error(`Agent operation binding is missing: ${operation}`);
  return binding;
};

type FidyClient = HttpApiClient.Client<FidyApiGroups>;
type BindClientOperation = <Input, Success, Failure extends object>(
  operation: OperationId,
  invoke: (input: Input) => Effect.Effect<Success, Failure, never>
) => ClientOperation;
type GroupClientOperations<Group extends string> = Record<
  Extract<OperationId, `${Group}.${string}`>,
  ClientOperation
>;

const identityClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"identity"> => ({
  "identity.getCurrentUser": bind("identity.getCurrentUser", client.identity.getCurrentUser),
  "identity.updateUserPreferences": bind(
    "identity.updateUserPreferences",
    client.identity.updateUserPreferences
  ),
});

const categoryClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"categories"> => ({
  "categories.listCategories": bind("categories.listCategories", client.categories.listCategories),
  "categories.listKeywordRules": bind(
    "categories.listKeywordRules",
    client.categories.listKeywordRules
  ),
  "categories.createKeywordRule": bind(
    "categories.createKeywordRule",
    client.categories.createKeywordRule
  ),
  "categories.updateKeywordRule": bind(
    "categories.updateKeywordRule",
    client.categories.updateKeywordRule
  ),
  "categories.deleteKeywordRule": bind(
    "categories.deleteKeywordRule",
    client.categories.deleteKeywordRule
  ),
});

const dashboardClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"dashboard"> => ({
  "dashboard.getDashboard": bind("dashboard.getDashboard", client.dashboard.getDashboard),
  "dashboard.listDashboardCatalog": bind(
    "dashboard.listDashboardCatalog",
    client.dashboard.listDashboardCatalog
  ),
  "dashboard.applyDashboardEdit": bind(
    "dashboard.applyDashboardEdit",
    client.dashboard.applyDashboardEdit
  ),
});

const transactionClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"transactions"> => ({
  "transactions.createTransaction": bind(
    "transactions.createTransaction",
    client.transactions.createTransaction
  ),
  "transactions.listTransactions": bind(
    "transactions.listTransactions",
    client.transactions.listTransactions
  ),
  "transactions.getTransaction": bind(
    "transactions.getTransaction",
    client.transactions.getTransaction
  ),
  "transactions.updateTransaction": bind(
    "transactions.updateTransaction",
    client.transactions.updateTransaction
  ),
  "transactions.deleteTransaction": bind(
    "transactions.deleteTransaction",
    client.transactions.deleteTransaction
  ),
  "transactions.listSourceAttestations": bind(
    "transactions.listSourceAttestations",
    client.transactions.listSourceAttestations
  ),
});

const ingestionClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"ingestion"> => ({
  "ingestion.submitForExtraction": bind(
    "ingestion.submitForExtraction",
    client.ingestion.submitForExtraction
  ),
  "ingestion.getStatementSubmission": bind(
    "ingestion.getStatementSubmission",
    client.ingestion.getStatementSubmission
  ),
  "ingestion.listNeedsReviewItems": bind(
    "ingestion.listNeedsReviewItems",
    client.ingestion.listNeedsReviewItems
  ),
  "ingestion.resolveNeedsReviewItem": bind(
    "ingestion.resolveNeedsReviewItem",
    client.ingestion.resolveNeedsReviewItem
  ),
});

const insightClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"insights"> => ({
  "insights.listPendingInsights": bind(
    "insights.listPendingInsights",
    client.insights.listPendingInsights
  ),
  "insights.markInsightDelivered": bind(
    "insights.markInsightDelivered",
    client.insights.markInsightDelivered
  ),
  "insights.markInsightRead": bind("insights.markInsightRead", client.insights.markInsightRead),
  "insights.dismissInsight": bind("insights.dismissInsight", client.insights.dismissInsight),
});

const memoryClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"memory"> => ({
  "memory.remember": bind("memory.remember", client.memory.remember),
  "memory.revise": bind("memory.revise", client.memory.revise),
  "memory.forget": bind("memory.forget", client.memory.forget),
  "memory.recall": bind("memory.recall", client.memory.recall),
});

const remainingClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): GroupClientOperations<"subscription"> & GroupClientOperations<"operations"> => ({
  "subscription.getUpgradeUrl": bind(
    "subscription.getUpgradeUrl",
    client.subscription.getUpgradeUrl
  ),
  "operations.executeAtomicBatch": bind(
    "operations.executeAtomicBatch",
    client.operations.executeAtomicBatch
  ),
});

const makeClientOperations = (
  client: FidyClient,
  bind: BindClientOperation
): Record<OperationId, ClientOperation> => ({
  ...identityClientOperations(client, bind),
  ...categoryClientOperations(client, bind),
  ...dashboardClientOperations(client, bind),
  ...transactionClientOperations(client, bind),
  ...ingestionClientOperations(client, bind),
  ...insightClientOperations(client, bind),
  ...memoryClientOperations(client, bind),
  ...remainingClientOperations(client, bind),
});

/**
 * Binds the derived toolkit to a turn-scoped TokenBearer. Each handler restores
 * the canonical id and calls the generated HTTP client through TokenAuthorization.
 */
export const makeAgentToolkit = (
  bearer: TokenBearer
): Effect.Effect<
  Toolkit.WithHandler<typeof AgentToolkit.tools>,
  never,
  HttpClient.HttpClient | Scope.Scope | Telemetry
> =>
  Effect.gen(function* () {
    const baseUrl = yield* CanonicalApiBaseUrl;
    const telemetry = yield* Telemetry;
    const authorization = HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) =>
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
    const bind: BindClientOperation = (operation, invoke) =>
      bindClientOperation(requireBinding(operation), invoke);
    const clientOperations = makeClientOperations(client, bind);
    const operationsById = new Map(Object.entries(clientOperations));
    const handlers = Object.fromEntries(
      agentOperationBindings.map((binding) => [
        binding.wireName,
        (input: unknown): Effect.Effect<unknown, object> => {
          const operation = operationsById.get(binding.operation);
          return operation === undefined
            ? Effect.die(new Error("Derived canonical API client operation is missing"))
            : operation(input);
        },
      ])
    );
    const handlerContext = yield* AgentToolkit.toHandlers(handlers);
    return yield* AgentToolkit.pipe(Effect.provide(handlerContext));
  });
