import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { operationCatalog } from "../../src/shell/api";
import { checkpointResponseSuggestions } from "../../src/shell/canonical-operations/operations";
import { installedCanonicalOperations } from "../canonical-operations/operations";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { OAuthCanonicalAdmission, projectMcpSchemas } from "../../src/shell/mcp/contract";
import { type OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { Unavailable } from "../../src/shell/public-http/contract";
import { type PATScopes } from "../../src/core/tokens/contract";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import { RequestBodyPolicy } from "../http/contract";
import { awaitRequestAbort, readBoundedRequestBody } from "../http/operations";
import { authenticateOAuth } from "../oauth-agents/operations";
import { protectCanonicalPressure } from "../canonical-admission/operations";

const queryLifetimeMilliseconds = 3000;
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 3000,
});
const responsePolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1_048_576,
  deadlineMilliseconds: 3000,
});
const noStore = { "cache-control": "no-store" };
type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
type ToolAdmission = Readonly<{
  db: D1Database;
  subject: OAuthCaller;
  scopes: PATScopes;
  coordinator: Coordinator;
}>;
const unavailable = (): Response =>
  Response.json(
    { error: { code: "unavailable", message: "This operation is unavailable." }, next: [] },
    { status: 503, headers: noStore }
  );
const denied = (): Response =>
  new Response(null, {
    status: 401,
    headers: {
      ...noStore,
      "www-authenticate":
        'Bearer resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp", scope="read"',
    },
  });
const canonicalToolResult = (
  input: Readonly<{ codec: CatalogOperation["failure"]; raw: unknown; isError: boolean }>
): Effect.Effect<McpSchema.CallToolResult, Schema.SchemaError> =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(input.codec)(input.raw);
    const structuredContent = yield* Schema.encodeUnknownEffect(input.codec)(value);
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(structuredContent);
    return McpSchema.CallToolResult.make({
      isError: input.isError,
      structuredContent,
      content: [{ type: "text", text }],
    });
  });
const toolFailure = (
  operation: CatalogOperation
): Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError> =>
  Effect.gen(function* () {
    const raw = yield* Schema.encodeEffect(Unavailable)(
      Unavailable.make({
        error: { code: "unavailable", message: "Canonical operation unavailable." },
        next: [],
      })
    );
    return yield* canonicalToolResult({ codec: operation.failure, raw, isError: true });
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(McpSchema.InternalError.make({ message: "Canonical operation unavailable." }))
    )
  );
const executeAdmittedTool = (
  input: ToolAdmission,
  operation: CatalogOperation,
  payload: unknown
): Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError> =>
  Effect.gen(function* () {
    const encodedInput = yield* Schema.decodeUnknownEffect(Schema.Json)(payload);
    const admission = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthCanonicalAdmission))({
      userId: input.subject.userId,
      connectionId: input.subject.oauthConnectionId,
      credentialId: input.subject.credentialId,
      clientId: input.subject.clientId,
      resource: input.subject.resource,
      digest: Array.from(input.subject.digest),
      deadlineMilliseconds: (yield* Clock.currentTimeMillis) + queryLifetimeMilliseconds,
      operation: operation.id,
      input: encodedInput,
    });
    const response = yield* Effect.tryPromise((signal) =>
      input.coordinator.getByName(input.subject.userId).fetch(
        new Request("https://coordinator.internal/oauth-canonical", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: admission,
          signal,
        })
      )
    );
    const bytes = yield* readBoundedRequestBody(
      new Request("https://coordinator.internal/result", {
        method: "POST",
        headers: response.headers,
        body: response.body,
      }),
      responsePolicy
    );
    const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
      new TextDecoder().decode(bytes)
    );
    const available = (target: CatalogOperation): boolean =>
      decideOperationAccess(target.policy.access, {
        _tag: "OAuthAgent",
        capabilities: input.scopes,
      })._tag === "Allowed";
    const result = yield* canonicalToolResult({
      codec: response.ok ? operation.success : operation.failure,
      raw: checkpointResponseSuggestions({ value: raw, catalog: operationCatalog, available }),
      isError: !response.ok,
    });
    const allowedIds = new Set(operationCatalog.operations.filter(available).map(({ id }) => id));
    const projected = projectMcpSchemas({ operation, catalog: operationCatalog, allowedIds });
    yield* Schema.decodeEffect(projected.output)(result.structuredContent ?? null);
    return result;
  }).pipe(
    Effect.timeoutOrElse({
      duration: queryLifetimeMilliseconds,
      orElse: () => toolFailure(operation),
    }),
    Effect.catchCause(() => toolFailure(operation))
  );
const executeTool = (
  input: ToolAdmission,
  operation: CatalogOperation,
  payload: unknown
): Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError> =>
  protectCanonicalPressure({
    db: input.db,
    userId: input.subject.userId,
    work: executeAdmittedTool(input, operation, payload),
    refused: (response) =>
      Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap((raw) =>
          canonicalToolResult({ codec: operation.failure, raw, isError: true })
        ),
        Effect.catchCause(() => toolFailure(operation))
      ),
  });
const schemaDocument = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Schema.decodeUnknownSync(Schema.Json)({ ...document.schema, $defs: document.definitions });
};
const registration = (
  input: ToolAdmission
): Effect.Effect<void, Schema.SchemaError, McpServer.McpServer> =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const operation of installedCanonicalOperations()
      .filter(
        ({ policy }) =>
          decideOperationAccess(policy.access, {
            _tag: "OAuthAgent",
            capabilities: input.scopes,
          })._tag === "Allowed"
      )
      .toSorted((left, right) => left.id.localeCompare(right.id))) {
      const allowedIds = new Set(
        operationCatalog.operations
          .filter(
            ({ policy }) =>
              decideOperationAccess(policy.access, {
                _tag: "OAuthAgent",
                capabilities: input.scopes,
              })._tag === "Allowed"
          )
          .map(({ id }) => id)
      );
      const projected = projectMcpSchemas({ operation, catalog: operationCatalog, allowedIds });
      const tool = yield* Schema.decodeUnknownEffect(McpSchema.Tool)({
        name: operation.id,
        description: operation.description,
        inputSchema: schemaDocument(projected.input),
        outputSchema: schemaDocument(projected.output),
        annotations: {
          readOnlyHint: operation.policy.kind === "query",
          destructiveHint: operation.policy.agentConfirmation === "required",
        },
      });
      yield* server.addTool({
        tool,
        annotations: Context.empty(),
        handle: (payload: unknown) => executeTool(input, operation, payload),
      });
    }
  });
/** Request-private protocol execution projects installed authorized canonical operations with bounded lifetime and cleanup. */
export const handleMcpRequest = (
  input: Readonly<{ request: Request; db: D1Database; coordinator: Coordinator }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.signal.aborted) return unavailable();
    const caller = yield* authenticateOAuth({ ...input, current: yield* Clock.currentTimeMillis });
    if (Option.isNone(caller)) return denied();
    const body = yield* readBoundedRequestBody(input.request, bodyPolicy);
    const server = McpServer.layerHttp({
      name: "fidy",
      version: "0.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
      allowedOrigins: [],
    });
    const routes = Layer.merge(
      server,
      Layer.effectDiscard(
        registration({ ...caller.value, db: input.db, coordinator: input.coordinator })
      ).pipe(Layer.provide(server))
    );
    const clock = yield* Clock.Clock;
    const handler = HttpRouter.toWebHandler(
      routes.pipe(Layer.provide(Layer.succeed(Clock.Clock, clock))),
      { disableLogger: true }
    );
    const request = new Request(input.request.url, {
      method: input.request.method,
      headers: input.request.headers,
      ...(input.request.method === "POST" ? { body } : {}),
      signal: input.request.signal,
    });
    const response = yield* Effect.tryPromise(() =>
      handler.handler(request, Context.make(Clock.Clock, clock))
    ).pipe(Effect.ensuring(Effect.tryPromise(() => handler.dispose()).pipe(Effect.ignore)));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }).pipe(
    Effect.raceFirst(awaitRequestAbort(input.request)),
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(unavailable()) }),
    Effect.catchCause(() => Effect.succeed(unavailable()))
  );
