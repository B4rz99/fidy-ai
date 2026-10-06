import { type Cause, Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { RpcSerialization } from "effect/rpc";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { operationCatalog } from "../../src/shell/api";
import { checkpointResponseSuggestions } from "../../src/shell/canonical-operations/operations";
import { installedCanonicalOperations } from "../canonical-operations/operations";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  OAuthCanonicalAdmission,
  type OAuthConfirmationAttempt,
  mcpCanonicalMetadata,
  projectMcpSchemas,
} from "../../src/shell/mcp/contract";
import { readNativeConfirmation, requestNativeConfirmation } from "./native-confirmation";
import { OAuthMcpAdmission, maximumMcpRequestBytes } from "./contract";
import { type OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { CanonicalAllowance, canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { Unavailable } from "../../src/shell/public-http/contract";
import { type PATScopes } from "../../src/core/tokens/contract";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import { RequestBodyPolicy } from "../http/contract";
import { awaitRequestAbort, readBoundedRequestBody } from "../http/operations";
import { authenticateOAuth, resolveOAuthMcpCaller } from "../oauth-agents/operations";
import {
  discloseCanonicalAllowance,
  protectCanonicalPressure,
} from "../canonical-admission/operations";

const queryLifetimeMilliseconds = 3000;
const transportLifetimeMilliseconds = 5000;
const maximumResidentOwners = 8;
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumMcpRequestBytes,
  deadlineMilliseconds: 3000,
});
const responsePolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1_048_576,
  deadlineMilliseconds: 3000,
});
const noStore = { "cache-control": "no-store" };
type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
type CanonicalQueue = (
  input: Readonly<{ admission: OAuthCanonicalAdmission; signal: AbortSignal }>
) => Effect.Effect<Response>;
type ToolAdmission = Readonly<{
  db: D1Database;
  subject: OAuthCaller;
  scopes: PATScopes;
}> &
  (
    | Readonly<{ coordinator: Coordinator }>
    | Readonly<{
        enqueueCanonicalWork: CanonicalQueue;
        signal: AbortSignal;
        transportDeadlineMilliseconds: number;
      }>
  );
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
const dispatchCanonicalTool = (
  input: ToolAdmission,
  admission: string
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  "enqueueCanonicalWork" in input
    ? Effect.scoped(
        Effect.gen(function* () {
          const scopeSignal = yield* Effect.abortSignal;
          const decoded = yield* Schema.decodeEffect(
            Schema.fromJsonString(OAuthCanonicalAdmission)
          )(admission);
          return yield* input.enqueueCanonicalWork({
            admission: decoded,
            signal: AbortSignal.any([input.signal, scopeSignal]),
          });
        })
      )
    : Effect.tryPromise((signal) =>
        input.coordinator.getByName(input.subject.userId).fetch(
          new Request("https://coordinator.internal/oauth-canonical", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: admission,
            signal,
          })
        )
      );
const canonicalDeadline = (
  input: Readonly<{ admission: ToolAdmission; current: number; continuation: boolean }>
): number => {
  const boundedExecution = input.current + queryLifetimeMilliseconds;
  if (input.continuation) return boundedExecution;
  return "transportDeadlineMilliseconds" in input.admission
    ? Math.min(boundedExecution, input.admission.transportDeadlineMilliseconds)
    : boundedExecution;
};

const decodeToolResponse = (
  input: ToolAdmission,
  operation: CatalogOperation,
  response: Response
): Effect.Effect<
  McpSchema.CallToolResult,
  Effect.Error<ReturnType<typeof readBoundedRequestBody>> | Schema.SchemaError
> =>
  Effect.gen(function* () {
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
    const allowance = Schema.decodeOption(Schema.toCodecJson(CanonicalAllowance))({
      allowance: response.headers.get(canonicalAllowanceHeaders.allowance),
      limit: response.headers.get(canonicalAllowanceHeaders.limit),
      remaining: response.headers.get(canonicalAllowanceHeaders.remaining),
      resetsAt: response.headers.get(canonicalAllowanceHeaders.resetsAt),
    });
    if (Option.isNone(allowance)) return result;
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(CanonicalAllowance))(
      allowance.value
    );
    const metadata = yield* Schema.decodeEffect(Schema.JsonObject)({
      [mcpCanonicalMetadata.allowance]: encoded,
    });
    return McpSchema.CallToolResult.make({
      isError: result.isError,
      structuredContent: result.structuredContent,
      content: result.content,
      _meta: metadata,
    });
  });

const executeAdmittedTool = (
  input: ToolAdmission,
  work: Readonly<{
    operation: CatalogOperation;
    payload: unknown;
    confirmation: Option.Option<OAuthConfirmationAttempt>;
  }>
): Effect.Effect<
  McpSchema.CallToolResult | McpSchema.InputRequired,
  McpSchema.InternalError,
  McpSchema.McpRequestContext
> =>
  Effect.gen(function* () {
    const { operation, payload } = work;
    const context = yield* McpSchema.McpRequestContext;
    const confirmation = readNativeConfirmation({ context, supplied: work.confirmation });
    if (confirmation._tag === "Invalid") return yield* toolFailure(operation);
    const encodedInput = yield* Schema.decodeUnknownEffect(Schema.Json)(payload);
    const admission = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthCanonicalAdmission))({
      userId: input.subject.userId,
      connectionId: input.subject.oauthConnectionId,
      credentialId: input.subject.credentialId,
      clientId: input.subject.clientId,
      resource: input.subject.resource,
      digest: Array.from(input.subject.digest),
      deadlineMilliseconds: canonicalDeadline({
        admission: input,
        current: yield* Clock.currentTimeMillis,
        continuation: Option.isSome(work.confirmation),
      }),
      operation: operation.id,
      input: encodedInput,
      ...(context.requestMetadata?.[mcpCanonicalMetadata.retryKey] === undefined
        ? {}
        : {
            retryKey: context.requestMetadata[mcpCanonicalMetadata.retryKey],
          }),
      ...Option.match(confirmation.attempt, {
        onNone: () => ({}),
        onSome: (confirmation) => ({ confirmation }),
      }),
    });
    const response = yield* dispatchCanonicalTool(input, admission).pipe(
      Effect.timeout(queryLifetimeMilliseconds)
    );
    if (response.headers.get("fidy-oauth-review") === "1") {
      const requested = yield* requestNativeConfirmation({ response, context, responsePolicy });
      if (requested._tag === "InputRequired") return requested.result;
      if (requested._tag === "Unavailable") return yield* toolFailure(operation);
      return yield* executeAdmittedTool(input, {
        ...work,
        confirmation: Option.some(requested.attempt),
      });
    }
    return yield* decodeToolResponse(input, operation, response);
  }).pipe(
    Effect.scoped,
    Effect.catchCause(() => toolFailure(work.operation))
  );
const executeTool = (
  input: ToolAdmission,
  operation: CatalogOperation,
  payload: unknown
): Effect.Effect<
  McpSchema.CallToolResult | McpSchema.InputRequired,
  McpSchema.InternalError,
  McpSchema.McpRequestContext
> =>
  protectCanonicalPressure({
    db: input.db,
    userId: input.subject.userId,
    work: executeAdmittedTool(input, { operation, payload, confirmation: Option.none() }),
    refused: (response) =>
      discloseCanonicalAllowance({
        db: input.db,
        caller: { _tag: "OAuth", value: input.subject },
        response,
      }).pipe(
        Effect.flatMap((response) => decodeToolResponse(input, operation, response)),
        Effect.catchCause(() => toolFailure(operation))
      ),
  });
const schemaDocument = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Schema.decodeUnknownSync(Schema.Json)({ ...document.schema, $defs: document.definitions });
};
type RegisteredTool = Readonly<{ operation: CatalogOperation; tool: McpSchema.Tool }>;
const catalogTools = (
  scopes: PATScopes
): Effect.Effect<ReadonlyArray<RegisteredTool>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const available = (operation: CatalogOperation): boolean =>
      decideOperationAccess(operation.policy.access, {
        _tag: "OAuthAgent",
        capabilities: scopes,
      })._tag === "Allowed";
    const allowedIds = new Set(operationCatalog.operations.filter(available).map(({ id }) => id));
    const tools: Array<RegisteredTool> = [];
    for (const operation of installedCanonicalOperations()
      .filter(available)
      .toSorted((left, right) => left.id.localeCompare(right.id))) {
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
      tools.push({ operation, tool });
    }
    return tools;
  });
const registration = (
  input: ToolAdmission
): Effect.Effect<void, Schema.SchemaError, McpServer.McpServer> =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const { operation, tool } of yield* catalogTools(input.scopes)) {
      yield* server.addTool({
        tool,
        annotations: Context.empty(),
        handle: (payload: unknown) => executeTool(input, operation, payload),
      });
    }
  });
const forwardStatefulMcp = (
  input: Readonly<{ request: Request; coordinator: Coordinator }>,
  subject: OAuthCaller,
  body: Uint8Array
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const headers = Object.fromEntries(
      Object.keys(OAuthMcpAdmission.fields.headers.fields).flatMap((name) => {
        const value = input.request.headers.get(name);
        return value === null ? [] : [[name, value]];
      })
    );
    const admitted = yield* Schema.decodeUnknownEffect(OAuthMcpAdmission)({
      userId: subject.userId,
      connectionId: subject.oauthConnectionId,
      credentialId: subject.credentialId,
      clientId: subject.clientId,
      resource: subject.resource,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: (yield* Clock.currentTimeMillis) + transportLifetimeMilliseconds,
      method: input.request.method,
      headers,
      body: Array.from(body),
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthMcpAdmission))(admitted);
    return yield* Effect.tryPromise((signal) =>
      input.coordinator.getByName(admitted.userId).fetch(
        new Request("https://coordinator.internal/oauth-mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
          signal,
        })
      )
    );
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
    if (statefulRequest(input.request, body)) {
      return yield* forwardStatefulMcp(input, caller.value.subject, body);
    }
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

const RpcRequestMetadata = Schema.TaggedStruct("Request", {
  tag: Schema.String,
  payload: Schema.Unknown,
});
const protocolRequests = (body: Uint8Array): ReadonlyArray<typeof RpcRequestMetadata.Type> => {
  try {
    return RpcSerialization.jsonRpc()
      .makeUnsafe()
      .decode(body)
      .flatMap((message) => {
        const decoded = Schema.decodeUnknownOption(RpcRequestMetadata)(message);
        return Option.isSome(decoded) ? [decoded.value] : [];
      });
  } catch {
    // The unchanged SDK still owns the malformed wire response; metadata cannot authorize work.
    return [];
  }
};
const statefulRequest = (request: Request, body: Uint8Array): boolean => {
  const version = request.headers.get("mcp-protocol-version");
  if (version === McpProtocol.v2026_07_28.protocolVersion) return false;
  if (
    version === McpProtocol.v2025_11_25.protocolVersion ||
    request.headers.has("mcp-session-id")
  ) {
    return true;
  }
  return protocolRequests(body).some(
    ({ tag, payload }) =>
      tag === "initialize" &&
      Option.isSome(
        Schema.decodeUnknownOption(
          Schema.Struct({
            // Effect negotiates the supported stateful version even when a client offers an
            // older version. Its resulting session must live in the resident owner, not
            // a one-request handler that is immediately disposed after initialization.
            protocolVersion: Schema.String,
          })
        )(payload)
      )
  );
};

type NativeToolAdmission = Readonly<{
  admission: Extract<ToolAdmission, { enqueueCanonicalWork: CanonicalQueue }>;
}>;
class NativeToolAdmissionContext extends Context.Service<
  NativeToolAdmissionContext,
  NativeToolAdmission
>()("@fidy/server/cloudflare/mcp/runtime/NativeToolAdmissionContext") {}
type NativeHttpHandler = Readonly<{
  handler: (request: Request, context?: Context.Context<never>) => Promise<Response>;
  dispose: () => Promise<void>;
}>;
type ResidentOwner = {
  readonly handler: NativeHttpHandler;
  readonly binding: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly fingerprint: string;
  readonly expiresAtMilliseconds: number;
  sessionId: Option.Option<string>;
  retiring: boolean;
  leases: number;
  drained: ReturnType<typeof Promise.withResolvers<void>>;
  disposal: Option.Option<Promise<void>>;
  readonly bodies: Set<() => Promise<void>>;
  readonly pendingTransfers: Set<Promise<void>>;
};
const callerBinding = (subject: OAuthCaller): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
    userId: subject.userId,
    connectionId: subject.oauthConnectionId,
    credentialId: subject.credentialId,
    clientId: subject.clientId,
    resource: subject.resource,
    digest: Array.from(subject.digest),
  });
const leaseOwner = (owner: ResidentOwner): (() => void) => {
  if (owner.leases === 0) owner.drained = Promise.withResolvers<void>();
  owner.leases += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    owner.leases -= 1;
    if (owner.leases === 0) owner.drained.resolve();
  };
};
/** Concurrent caller/disposer cancellation joins the same locked SDK reader settlement. */
const leaseNativeReader = (
  owner: ResidentOwner,
  ticket: ResidentTicket,
  reader: Pick<ReadableStreamDefaultReader<unknown>, "cancel">
): Readonly<{ finish: () => void; cancel: () => Promise<void> }> => {
  const { release } = ticket;
  let cancelling = false;
  let cancellation: Option.Option<Promise<void>> = Option.none();
  const finish = (): void => {
    if (cancelling) return;
    owner.bodies.delete(cancel);
    release();
  };
  const cancel = (): Promise<void> => {
    if (Option.isSome(cancellation)) return cancellation.value;
    cancelling = true;
    const pending = Promise.resolve()
      .then(() => reader.cancel())
      .finally(() => {
        cancelling = false;
        finish();
      });
    cancellation = Option.some(pending);
    return pending;
  };
  ticket.cancelBody = Option.some(cancel);
  owner.bodies.add(cancel);
  return { finish, cancel };
};
/** A Response lease lasts through native streaming, not merely response-header completion. */
const leasedResponse = (
  owner: ResidentOwner,
  response: Response,
  ticket: ResidentTicket
): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (response.body === null) {
    ticket.release();
    return new Response(null, { status: response.status, headers });
  }
  const reader = response.body.getReader();
  const { finish, cancel } = leaseNativeReader(owner, ticket, reader);
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        return reader
          .read()
          .then((chunk) => {
            if (chunk.done) {
              finish();
              controller.close();
            } else {
              const value: unknown = chunk.value;
              if (!(value instanceof Uint8Array)) {
                throw new Error("Invalid native MCP response bytes.");
              }
              controller.enqueue(value);
            }
          })
          .catch((error: unknown) => {
            finish();
            controller.error(error);
          });
      },
      cancel,
    }),
    { status: response.status, headers }
  );
};
export type McpResidency = Readonly<{
  handle: (
    input: Readonly<{ admission: OAuthMcpAdmission; signal: AbortSignal }>
  ) => Effect.Effect<Response>;
  dispose: () => Effect.Effect<void, Cause.UnknownError>;
  retireConnections: (connectionId: Option.Option<string>) => Effect.Effect<void>;
}>;
/** One volatile residency owner per existing User coordinator, never a global caller-tool cache. */
type ResidencyConfig = Readonly<{
  userId: string;
  db: D1Database;
  enqueueCanonicalWork: CanonicalQueue;
}>;
type ResidentRegistry = {
  readonly config: ResidencyConfig;
  readonly owners: Set<ResidentOwner>;
  closed: boolean;
};
type ResidentCatalog = Readonly<{
  subject: OAuthCaller;
  scopes: PATScopes;
  tools: ReadonlyArray<RegisteredTool>;
  fingerprint: string;
  expiresAtMilliseconds: number;
}>;
type ResidentRequest = Readonly<{ admission: OAuthMcpAdmission; signal: AbortSignal }>;
type ResidentTicket = {
  owner: Option.Option<ResidentOwner>;
  release: () => void;
  transferred: boolean;
  settleTransfer: () => void;
  cancelBody: Option.Option<() => Promise<void>>;
};
/** Readiness is resolve-only: a pinned ticket either registers its body or terminates. */
const pinResidentTicket = (
  registry: ResidentRegistry,
  input: Readonly<{ owner: ResidentOwner; ticket: ResidentTicket }>
): void => {
  const { owner, ticket } = input;
  if (registry.closed || owner.retiring || Option.isSome(owner.disposal)) return;
  const ready = Promise.withResolvers<void>();
  owner.pendingTransfers.add(ready.promise);
  ticket.owner = Option.some(owner);
  ticket.release = leaseOwner(owner);
  ticket.settleTransfer = (): void => {
    ready.resolve();
    owner.pendingTransfers.delete(ready.promise);
  };
};
const finishResidentTicket = (ticket: ResidentTicket): void => {
  if (!ticket.transferred) ticket.release();
  ticket.settleTransfer();
};
const releaseResidentTicket = (
  ticket: ResidentTicket,
  failed: boolean
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    if (!failed) return;
    if (Option.isSome(ticket.owner)) ticket.owner.value.retiring = true;
    if (Option.isSome(ticket.cancelBody)) yield* Effect.tryPromise(ticket.cancelBody.value);
  }).pipe(Effect.ensuring(Effect.sync(() => finishResidentTicket(ticket))));
type ResidentTool = Readonly<{
  registry: ResidentRegistry;
  owner: ResidentOwner;
  operation: CatalogOperation;
}>;
const fingerprint = (
  tools: ReadonlyArray<RegisteredTool>
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Array(McpSchema.Tool)))(
    tools.map(({ tool }) => tool)
  );
type OwnerDisposalSettlement =
  | Readonly<{ _tag: "Success" }>
  | Readonly<{ _tag: "Failure"; error: unknown }>;
/** Observe SDK rejection immediately; the original error is rethrown after owned cleanup. */
const settledDisposal = (promise: Promise<unknown>): Promise<OwnerDisposalSettlement> =>
  promise.then(
    () => ({ _tag: "Success" }),
    (error: unknown) => ({ _tag: "Failure", error })
  );
const settleNativeDisposal = (owner: ResidentOwner): Promise<OwnerDisposalSettlement> => {
  try {
    return settledDisposal(owner.handler.dispose());
  } catch (error) {
    return Promise.resolve({ _tag: "Failure", error });
  }
};
const settleOwnerResponses = (owner: ResidentOwner): Promise<OwnerDisposalSettlement> =>
  settledDisposal(
    Promise.all(owner.pendingTransfers)
      .then(() => Promise.all(Array.from(owner.bodies, (cancel) => cancel())))
      .then(() => owner.drained.promise)
  );
const completeOwnerDisposal = (registry: ResidentRegistry, owner: ResidentOwner): Promise<void> => {
  // Initiate SDK interruption before joining callbacks' transfer readiness.
  const native = settleNativeDisposal(owner);
  return settleOwnerResponses(owner).then((responses) =>
    native.then((sdk) => {
      if (sdk._tag === "Failure" && responses._tag === "Failure") {
        throw new AggregateError([sdk.error, responses.error], "Native MCP disposal failed.");
      }
      if (sdk._tag === "Failure") throw sdk.error;
      if (responses._tag === "Failure") throw responses.error;
      registry.owners.delete(owner);
    })
  );
};
const disposeOwner = (registry: ResidentRegistry, owner: ResidentOwner): Promise<void> => {
  if (Option.isSome(owner.disposal)) return owner.disposal.value;
  owner.retiring = true;
  const disposal = Promise.resolve().then(() => completeOwnerDisposal(registry, owner));
  owner.disposal = Option.some(disposal);
  return disposal;
};
const executeResidentTool = (
  target: ResidentTool,
  current: ToolAdmission,
  payload: unknown
): Effect.Effect<
  McpSchema.CallToolResult | McpSchema.InputRequired,
  McpSchema.InternalError,
  McpSchema.McpRequestContext
> =>
  Effect.gen(function* () {
    const live = yield* resolveOAuthMcpCaller({
      db: target.registry.config.db,
      subject: current.subject,
      current: yield* Clock.currentTimeMillis,
    });
    if (Option.isNone(live)) {
      target.owner.retiring = true;
      return yield* toolFailure(target.operation);
    }
    const currentTools = yield* catalogTools(live.value.scopes);
    if (
      callerBinding(current.subject) !== target.owner.binding ||
      (yield* fingerprint(currentTools)) !== target.owner.fingerprint ||
      (yield* Clock.currentTimeMillis) >= target.owner.expiresAtMilliseconds
    ) {
      target.owner.retiring = true;
      return yield* toolFailure(target.operation);
    }
    return yield* executeTool({ ...current, scopes: live.value.scopes }, target.operation, payload);
  }).pipe(Effect.catch(() => toolFailure(target.operation)));
const residentToolCallback = (
  target: ResidentTool,
  payload: unknown
): Effect.Effect<
  McpSchema.CallToolResult | McpSchema.InputRequired,
  McpSchema.InternalError,
  McpSchema.McpRequestContext
> =>
  Effect.gen(function* () {
    const invocation = yield* Effect.serviceOption(NativeToolAdmissionContext);
    if (Option.isNone(invocation) || target.owner.retiring) {
      return yield* toolFailure(target.operation);
    }
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => leaseOwner(target.owner)),
      () => executeResidentTool(target, invocation.value.admission, payload),
      (release) => Effect.sync(release)
    );
  });
const residentRegistration = (
  registry: ResidentRegistry,
  owner: () => ResidentOwner,
  tools: ReadonlyArray<RegisteredTool>
): Effect.Effect<void, never, McpServer.McpServer> =>
  Effect.gen(function* () {
    const service = yield* McpServer.McpServer;
    for (const { operation, tool } of tools) {
      yield* service.addTool({
        tool,
        annotations: Context.empty(),
        handle: (payload: unknown) =>
          residentToolCallback({ registry, owner: owner(), operation }, payload),
      });
    }
  });
const createOwner = (registry: ResidentRegistry, catalog: ResidentCatalog): ResidentOwner => {
  const server = McpServer.layerHttp({
    name: "fidy",
    version: "0.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2025_11_25],
    allowedOrigins: [],
  });
  const registered = residentRegistration(registry, () => owner, catalog.tools);
  const handler = HttpRouter.toWebHandler(
    Layer.merge(server, Layer.effectDiscard(registered).pipe(Layer.provide(server))),
    { disableLogger: true }
  );
  const drained = Promise.withResolvers<void>();
  drained.resolve();
  const owner: ResidentOwner = {
    handler,
    binding: callerBinding(catalog.subject),
    connectionId: catalog.subject.oauthConnectionId,
    clientId: catalog.subject.clientId,
    resource: catalog.subject.resource,
    fingerprint: catalog.fingerprint,
    expiresAtMilliseconds: catalog.expiresAtMilliseconds,
    sessionId: Option.none(),
    retiring: false,
    leases: 0,
    drained,
    disposal: Option.none(),
    bodies: new Set(),
    pendingTransfers: new Set(),
  };
  registry.owners.add(owner);
  return owner;
};
const admissionSubject = (admission: OAuthMcpAdmission): OAuthCaller => ({
  userId: admission.userId,
  oauthConnectionId: admission.connectionId,
  credentialId: admission.credentialId,
  clientId: admission.clientId,
  resource: admission.resource,
  digest: new Uint8Array(admission.digest),
  requiredScope: Option.none(),
});
const retireBinding = (registry: ResidentRegistry, binding: string): void => {
  for (const owner of registry.owners) if (owner.binding === binding) owner.retiring = true;
};
const sessionCorrelated = (
  owner: ResidentOwner,
  request: ResidentRequest,
  subject: OAuthCaller
): boolean =>
  Option.isSome(owner.sessionId) &&
  owner.sessionId.value === request.admission.headers["mcp-session-id"] &&
  owner.connectionId === subject.oauthConnectionId &&
  owner.clientId === subject.clientId &&
  owner.resource === subject.resource;
const selectResidentTicket = (
  registry: ResidentRegistry,
  request: ResidentRequest,
  selection: Readonly<{ catalog: ResidentCatalog; current: number }>
): ResidentTicket => {
  const { catalog, current } = selection;
  let selected: Option.Option<ResidentOwner> = Option.none();
  const binding = callerBinding(catalog.subject);
  for (const owner of registry.owners) {
    if (current >= owner.expiresAtMilliseconds) owner.retiring = true;
    if (!sessionCorrelated(owner, request, catalog.subject)) continue;
    if (owner.binding !== binding || owner.fingerprint !== catalog.fingerprint) {
      owner.retiring = true;
    }
    if (!owner.retiring) selected = Option.some(owner);
  }
  const ticket: ResidentTicket = {
    owner: Option.none(),
    release: (): void => {},
    transferred: false,
    settleTransfer: (): void => {},
    cancelBody: Option.none(),
  };
  if (Option.isSome(selected)) pinResidentTicket(registry, { owner: selected.value, ticket });
  return ticket;
};
const sweepRetiring = (registry: ResidentRegistry): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (const owner of registry.owners) {
      if (owner.retiring && owner.leases === 0) {
        yield* Effect.tryPromise(() => disposeOwner(registry, owner));
      }
    }
  });
const reserveResidentOwner = (
  registry: ResidentRegistry,
  request: ResidentRequest,
  catalog: ResidentCatalog
): Effect.Effect<Option.Option<ResidentOwner>, Cause.UnknownError> =>
  Effect.gen(function* () {
    if (registry.owners.size >= maximumResidentOwners) {
      const idle = Option.fromUndefinedOr(
        Array.from(registry.owners).find((owner) => owner.leases === 0)
      );
      if (Option.isNone(idle)) return Option.none();
      yield* Effect.tryPromise(() => disposeOwner(registry, idle.value));
    }
    // Recheck after asynchronous native disposal; no capacity is released while retiring.
    if (
      registry.closed ||
      registry.owners.size >= maximumResidentOwners ||
      request.signal.aborted
    ) {
      return Option.none();
    }
    return Option.some(createOwner(registry, catalog));
  });
const ensureResidentOwner = (
  registry: ResidentRegistry,
  input: Readonly<{ request: ResidentRequest; catalog: ResidentCatalog; ticket: ResidentTicket }>
): Effect.Effect<Option.Option<ResidentOwner>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { request, catalog, ticket } = input;
    yield* sweepRetiring(registry);
    if (registry.closed || request.signal.aborted) return Option.none();
    if (Option.isSome(ticket.owner) && ticket.owner.value.retiring) {
      finishResidentTicket(ticket);
      ticket.owner = Option.none();
      ticket.release = (): void => {};
      ticket.settleTransfer = (): void => {};
    }
    if (Option.isNone(ticket.owner)) {
      const reserved = yield* reserveResidentOwner(registry, request, catalog);
      if (Option.isSome(reserved)) pinResidentTicket(registry, { owner: reserved.value, ticket });
    }
    return ticket.owner;
  });
const invokeResidentHandler = (
  registry: ResidentRegistry,
  input: Readonly<{ request: ResidentRequest; catalog: ResidentCatalog; owner: ResidentOwner }>
): Effect.Effect<Option.Option<Response>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const {
      request: { admission, signal },
      catalog,
      owner,
    } = input;
    const clock = yield* Clock.Clock;
    const context = Context.make(Clock.Clock, clock).pipe(
      Context.add(NativeToolAdmissionContext, {
        admission: {
          db: registry.config.db,
          subject: catalog.subject,
          scopes: catalog.scopes,
          enqueueCanonicalWork: registry.config.enqueueCanonicalWork,
          signal,
          transportDeadlineMilliseconds: admission.deadlineMilliseconds,
        },
      })
    );
    const request = new Request("https://coordinator.internal/mcp", {
      method: admission.method,
      headers: admission.headers,
      ...(admission.method === "POST" ? { body: new Uint8Array(admission.body) } : {}),
      signal,
    });
    return yield* Effect.tryPromise(() => {
      // Same-turn recheck at the actual SDK boundary, after all context/clock preparation.
      if (registry.closed || owner.retiring || Option.isSome(owner.disposal)) {
        return Promise.resolve(Option.none<Response>());
      }
      return owner.handler.handler(request, context).then(Option.some);
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              owner.retiring = true;
            })
      )
    );
  });
const transferResidentResponse = (
  owner: ResidentOwner,
  response: Response,
  ticket: ResidentTicket
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.sync(() => {
    const issued = Option.fromNullOr(response.headers.get("mcp-session-id"));
    if (Option.isNone(owner.sessionId)) owner.sessionId = issued;
    if (Option.isNone(owner.sessionId)) owner.retiring = true;
    // The pre-owned ticket, not the current retirement state, owns this native reply.
    const leased = leasedResponse(owner, response, ticket);
    ticket.transferred = true;
    ticket.settleTransfer();
    return leased;
  });
/** Only ingress acquisition/handoff is masked; SDK RPC/financial fibers retain their own cancellation. */
const ownResidentReply = (
  registry: ResidentRegistry,
  input: Readonly<{
    request: ResidentRequest;
    catalog: ResidentCatalog;
    ticket: ResidentTicket;
    owner: ResidentOwner;
  }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const response = yield* invokeResidentHandler(registry, input);
      if (Option.isNone(response)) return unavailable();
      return yield* transferResidentResponse(input.owner, response.value, input.ticket);
    })
  );
const useResidentTicket = (
  registry: ResidentRegistry,
  input: Readonly<{ request: ResidentRequest; catalog: ResidentCatalog; ticket: ResidentTicket }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const owner = yield* ensureResidentOwner(registry, input);
    if (Option.isNone(owner)) return unavailable();
    if ((yield* Clock.currentTimeMillis) >= input.request.admission.deadlineMilliseconds) {
      return unavailable();
    }
    return yield* ownResidentReply(registry, { ...input, owner: owner.value });
  });
const handleResidentRequest = (
  registry: ResidentRegistry,
  request: ResidentRequest
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { admission, signal } = request;
    if (registry.closed || admission.userId !== registry.config.userId || signal.aborted) {
      return unavailable();
    }
    const current = yield* Clock.currentTimeMillis;
    if (current >= admission.deadlineMilliseconds) return unavailable();
    const subject = admissionSubject(admission);
    const live = yield* resolveOAuthMcpCaller({ db: registry.config.db, subject, current });
    if (Option.isNone(live)) {
      retireBinding(registry, callerBinding(subject));
      return denied();
    }
    const tools = yield* catalogTools(live.value.scopes);
    const catalogFingerprint = yield* fingerprint(tools);
    const selectedAt = yield* Clock.currentTimeMillis;
    const expiresAtMilliseconds = Math.min(
      DateTime.toEpochMillis(live.value.credentialExpiresAt),
      DateTime.toEpochMillis(live.value.grantExpiresAt)
    );
    if (selectedAt >= expiresAtMilliseconds) return denied();
    const catalog: ResidentCatalog = {
      subject,
      scopes: live.value.scopes,
      tools,
      fingerprint: catalogFingerprint,
      expiresAtMilliseconds,
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => selectResidentTicket(registry, request, { catalog, current: selectedAt })),
      (ticket) => useResidentTicket(registry, { request, catalog, ticket }),
      (ticket, exit) => releaseResidentTicket(ticket, exit._tag === "Failure")
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));
const retireConnections = (
  registry: ResidentRegistry,
  connectionId: Option.Option<string>
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const owner of registry.owners) {
      if (Option.isNone(connectionId) || owner.connectionId === connectionId.value) {
        owner.retiring = true;
      }
    }
    // Do not await native shutdown while holding a financial ticket: callbacks use that chain.
  });
const disposeRegistry = (registry: ResidentRegistry): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    registry.closed = true;
    for (const owner of registry.owners) {
      yield* Effect.tryPromise(() => disposeOwner(registry, owner));
    }
  });
export const makeMcpResidency = (config: ResidencyConfig): McpResidency => {
  const registry: ResidentRegistry = { config, owners: new Set(), closed: false };
  return {
    handle: (request) => handleResidentRequest(registry, request),
    retireConnections: (connectionId) => retireConnections(registry, connectionId),
    dispose: () => disposeRegistry(registry),
  };
};
