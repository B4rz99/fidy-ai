import { coreRejectionObserver } from "../runtime/operational-health/runtime";
import {
  type Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { operationCatalog } from "../../src/shell/api";
import { checkpointResponseSuggestions } from "../../src/shell/canonical-operations/operations";
import { nativeMcpCatalog } from "./operations";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  OAuthCanonicalAdmission,
  type OAuthConfirmationAttempt,
  mcpCanonicalMetadata,
  projectMcpSchemas,
} from "../../src/shell/mcp/contract";
import {
  NativeConfirmation,
  NativeConfirmationRead,
  readNativeConfirmation,
  requestNativeConfirmation,
} from "./native-confirmation";
import {
  OperationAccessCaller,
  OperationAccessDecision,
} from "../../src/shell/canonical-policy/contract";
import { leaseNativeReader } from "./internal/native-reader";
import { OAuthMcpAdmission, maximumMcpRequestBytes } from "./contract";
import { type OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { CanonicalAllowance, canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { Unavailable } from "../../src/shell/public-http/contract";
import { type PATScopes } from "../../src/core/tokens/contract";
import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import { RequestBodyPolicy } from "../http/contract";
import { readBoundedRequestBody } from "../http/operations";
import { type resolveLocalOAuthCaller } from "../oauth-agents/operations";

const queryLifetimeMilliseconds = 3000;

const mutationLifetimeMilliseconds = 30000;

const admissionLifetimeMilliseconds = 5000;

const transportLifetimeMilliseconds = mutationLifetimeMilliseconds + admissionLifetimeMilliseconds;

const maximumResidentOwners = 8;

const maximumResidentLifetimeMilliseconds = 300000;

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumMcpRequestBytes,
  deadlineMilliseconds: 3000,
});

const responsePolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1_048_576,
  deadlineMilliseconds: 3000,
});

const noStore = { "cache-control": "no-store" };

type CanonicalQueue = (
  input: Readonly<{ admission: OAuthCanonicalAdmission; signal: AbortSignal }>
) => Effect.Effect<Response>;

type ToolAdmission = Readonly<{
  observeRejections: ReturnType<typeof coreRejectionObserver>;
  subject: OAuthCaller;
  scopes: PATScopes;
  enqueueCanonicalWork: CanonicalQueue;
  signal: AbortSignal;
  transportDeadlineMilliseconds: number;
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
    Effect.tapCause(Effect.logDebug),
    Effect.catchCause(() =>
      Effect.fail(McpSchema.InternalError.make({ message: "Canonical operation unavailable." }))
    )
  );

const dispatchCanonicalTool = (
  input: ToolAdmission,
  admission: string
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeSignal = yield* Effect.abortSignal;

      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthCanonicalAdmission))(
        admission
      );

      return yield* input.enqueueCanonicalWork({
        admission: decoded,
        signal: AbortSignal.any([input.signal, scopeSignal]),
      });
    })
  );

const isAllowed = OperationAccessDecision.$is("Allowed");

const isInvalidConfirmation = NativeConfirmationRead.$is("Invalid");

const availableTo =
  (scopes: PATScopes) =>
  (operation: CatalogOperation): boolean =>
    isAllowed(
      decideOperationAccess(
        operation.policy.access,
        OperationAccessCaller.OAuthAgent({ capabilities: scopes })
      )
    );

const operationLifetime = (operation: CatalogOperation): number =>
  operation.policy.kind === "mutation" ? mutationLifetimeMilliseconds : queryLifetimeMilliseconds;

const canonicalDeadline = (
  input: Readonly<{
    admission: ToolAdmission;
    current: number;
    continuation: boolean;
    operation: CatalogOperation;
  }>
): number => {
  const boundedExecution = input.current + operationLifetime(input.operation);

  if (input.continuation) return boundedExecution;

  return Math.min(boundedExecution, input.admission.transportDeadlineMilliseconds);
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

    const available = availableTo(input.scopes);

    const result = yield* canonicalToolResult({
      codec: response.ok ? operation.success : operation.failure,
      raw: checkpointResponseSuggestions({ value: raw, catalog: operationCatalog, available }),
      isError: !response.ok,
    });

    yield* input.observeRejections({
      now: yield* Clock.currentTimeMillis,
      boundary: "mcp",
      status: response.status,
    });
    const allowedIds = new Set(operationCatalog.operations.filter(available).map(({ id }) => id));
    const projected = projectMcpSchemas({ operation, catalog: operationCatalog, allowedIds });
    yield* Schema.decodeUnknownEffect(projected.output)(result.structuredContent ?? null);

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
    const context = yield* McpSchema.McpRequestContext;
    const confirmation = readNativeConfirmation({ context, supplied: work.confirmation });

    if (isInvalidConfirmation(confirmation)) return yield* toolFailure(work.operation);

    const retryKey = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.Json))(
      context.requestMetadata?.[mcpCanonicalMetadata.retryKey]
    );

    const required = {
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
        operation: work.operation,
      }),
      operation: work.operation.id,
      input: yield* Schema.decodeUnknownEffect(Schema.Json)(work.payload),
    };

    const retried = retryKey === undefined ? required : { ...required, retryKey };

    const admission = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthCanonicalAdmission))(
      Option.match(confirmation.attempt, {
        onNone: () => retried,
        onSome: (attempt) => ({ ...retried, confirmation: attempt }),
      })
    );

    const response = yield* dispatchCanonicalTool(input, admission).pipe(
      Effect.timeout(operationLifetime(work.operation))
    );

    if (response.headers.get("fidy-oauth-review") === "1") {
      const requested = yield* requestNativeConfirmation({ response, context, responsePolicy });

      return yield* NativeConfirmation.$match(requested, {
        InputRequired: ({ result }) => Effect.succeed(result),
        Unavailable: () => toolFailure(work.operation),
        Decision: ({ attempt }) =>
          executeAdmittedTool(input, { ...work, confirmation: Option.some(attempt) }),
      });
    }

    return yield* decodeToolResponse(input, work.operation, response);
  }).pipe(
    Effect.scoped,
    Effect.catchCause(() => toolFailure(work.operation))
  );

const schemaDocument = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema);

  return Schema.decodeUnknownSync(Schema.Json)({ ...document.schema, $defs: document.definitions });
};

type RegisteredTool = Readonly<{ operation: CatalogOperation; tool: McpSchema.Tool }>;

type CatalogProjection = Readonly<{ tools: ReadonlyArray<RegisteredTool>; fingerprint: string }>;

const catalogProjections = new Map<string, CatalogProjection>();

const registeredTool = Effect.fn(function* (
  operation: CatalogOperation,
  allowedIds: ReadonlySet<string>
) {
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

  return { operation, tool };
});

const catalogTools = (scopes: PATScopes): Effect.Effect<CatalogProjection, Schema.SchemaError> =>
  Effect.gen(function* () {
    const available = availableTo(scopes);

    const allowedIds = new Set(operationCatalog.operations.filter(available).map(({ id }) => id));
    const projectionKey = scopes.toSorted().join(" ");
    const cached = catalogProjections.get(projectionKey);

    if (cached !== undefined) return cached;

    const operations = nativeMcpCatalog()
      .filter(available)
      .toSorted((left, right) => left.id.localeCompare(right.id));

    const tools = yield* Effect.forEach(operations, (operation) =>
      registeredTool(operation, allowedIds)
    );

    const projection = {
      tools,
      fingerprint: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(McpSchema.Tool)))(
        tools.map(({ tool }) => tool)
      ),
    };

    catalogProjections.set(projectionKey, projection);

    return projection;
  });

const prepareMcp = (
  input: Readonly<{ request: Request; lifetimeMilliseconds: number }>,
  subject: OAuthCaller,
  body: Uint8Array
): Effect.Effect<OAuthMcpAdmission, Schema.SchemaError> =>
  Effect.gen(function* () {
    const headers = Object.fromEntries(
      Object.keys(OAuthMcpAdmission.fields.headers.fields).flatMap((name) => {
        const value = input.request.headers.get(name);

        return value === null ? [] : [[name, value]];
      })
    );

    return yield* Schema.decodeUnknownEffect(OAuthMcpAdmission)({
      userId: subject.userId,
      connectionId: subject.oauthConnectionId,
      credentialId: subject.credentialId,
      clientId: subject.clientId,
      resource: subject.resource,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: (yield* Clock.currentTimeMillis) + input.lifetimeMilliseconds,
      method: input.request.method,
      headers,
      body: Array.from(body),
    });
  });

const TimedToolCall = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal(McpSchema.CallTool._tag),
    params: Schema.Struct({ name: McpSchema.CallTool.payloadSchema.fields.name }),
  })
);

const requestLifetime = (body: Uint8Array): number => {
  const call = Schema.decodeOption(TimedToolCall)(new TextDecoder().decode(body));

  return Option.isSome(call) &&
    operationCatalog.byId.get(call.value.params.name)?.policy.kind === "mutation"
    ? transportLifetimeMilliseconds
    : admissionLifetimeMilliseconds;
};

type NativeToolAdmission = Readonly<{
  admission: ToolAdmission;
}>;

class NativeToolAdmissionContext extends Context.Service<
  NativeToolAdmissionContext,
  NativeToolAdmission
>()("@fidy/server/cloudflare/mcp/runtime/NativeToolAdmissionContext") {}

type NativeHttpHandler = ReturnType<
  typeof HttpRouter.toWebHandler<never, never, never, never, never, never>
>;

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

type LeasedReader = Readonly<{
  finish: () => void;
  cancel: () => Promise<void>;
  isReleased: () => boolean;
}>;

const leaseResponseReader = (
  owner: ResidentOwner,
  ticket: ResidentTicket,
  reader: Pick<ReadableStreamDefaultReader<unknown>, "cancel" | "releaseLock">
): LeasedReader => {
  const { release } = ticket;
  let released = false;

  const { finish, cancel } = leaseNativeReader({
    reader,
    releaseLease: () => {
      released = true;
      owner.bodies.delete(cancel);
      release();
    },
  });

  ticket.cancelBody = Option.some(cancel);
  owner.bodies.add(cancel);

  return { finish, cancel, isReleased: () => released };
};

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
  const { finish, cancel, isReleased } = leaseResponseReader(owner, ticket, reader);

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (isReleased()) {
          controller.close();

          return Promise.resolve();
        }

        return reader
          .read()
          .then((chunk) => {
            if (chunk.done) {
              finish();
              controller.close();
            } else {
              const value: unknown = chunk.value;

              if (!Predicate.isUint8Array(value)) {
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
  erasureSettled: () => Effect.Effect<boolean>;
  retireConnections: (connectionId: Option.Option<string>) => Effect.Effect<void>;
}>;

type ResidencyConfig = Readonly<{
  userId: string;
  resolveCaller: (input: {
    subject: OAuthCaller;
    current: number;
  }) => Effect.Effect<
    Effect.Success<ReturnType<typeof resolveLocalOAuthCaller>>,
    Effect.Error<ReturnType<typeof resolveLocalOAuthCaller>>
  >;
  enqueueCanonicalWork: CanonicalQueue;
}>;

type ResidentRegistry = {
  readonly observeRejections: ReturnType<typeof coreRejectionObserver>;
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

type OwnerDisposalSettlement = Data.TaggedEnum<{
  Success: {};
  Failure: { readonly error: unknown };
}>;

const OwnerDisposalSettlement = Data.taggedEnum<OwnerDisposalSettlement>();

const isDisposalFailure = OwnerDisposalSettlement.$is("Failure");

const settledDisposal = (promise: Promise<unknown>): Promise<OwnerDisposalSettlement> =>
  promise.then(
    () => OwnerDisposalSettlement.Success(),
    (error: unknown) => OwnerDisposalSettlement.Failure({ error })
  );

const settleNativeDisposal = (owner: ResidentOwner): Promise<OwnerDisposalSettlement> => {
  try {
    return settledDisposal(owner.handler.dispose());
  } catch (error) {
    return Promise.resolve(OwnerDisposalSettlement.Failure({ error }));
  }
};

const settleOwnerResponses = (owner: ResidentOwner): Promise<OwnerDisposalSettlement> =>
  settledDisposal(
    Promise.all(owner.pendingTransfers)
      .then(() => Promise.all(Array.from(owner.bodies, (cancel) => cancel())))
      .then(() => owner.drained.promise)
  );

const completeOwnerDisposal = (registry: ResidentRegistry, owner: ResidentOwner): Promise<void> => {
  const native = settleNativeDisposal(owner);

  return settleOwnerResponses(owner).then((responses) =>
    native.then((sdk) => {
      if (isDisposalFailure(sdk) && isDisposalFailure(responses)) {
        throw new AggregateError([sdk.error, responses.error], "Native MCP disposal failed.");
      }

      if (isDisposalFailure(sdk)) throw sdk.error;

      if (isDisposalFailure(responses)) throw responses.error;
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
    const live = yield* target.registry.config.resolveCaller({
      subject: current.subject,
      current: yield* Clock.currentTimeMillis,
    });

    if (Option.isNone(live)) {
      target.owner.retiring = true;

      return yield* toolFailure(target.operation);
    }

    const currentCatalog = yield* catalogTools(live.value.scopes);

    if (
      callerBinding(current.subject) !== target.owner.binding ||
      currentCatalog.fingerprint !== target.owner.fingerprint ||
      (yield* Clock.currentTimeMillis) >= target.owner.expiresAtMilliseconds
    ) {
      target.owner.retiring = true;

      return yield* toolFailure(target.operation);
    }

    return yield* executeAdmittedTool(
      { ...current, scopes: live.value.scopes },
      {
        operation: target.operation,
        payload,
        confirmation: Option.none(),
      }
    );
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

    yield* Effect.forEach(
      tools,
      ({ operation, tool }) =>
        service.addTool({
          tool,
          annotations: Context.empty(),
          handle: (payload: unknown) =>
            residentToolCallback({ registry, owner: owner(), operation }, payload),
        }),
      { discard: true }
    );
  });

const residentLifetime = (
  registry: ResidentRegistry,
  owner: Effect.Effect<ResidentOwner>,
  clock: Clock.Clock
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const resident = yield* owner;
    yield* Effect.forkScoped(
      Effect.sleep(
        Math.max(0, resident.expiresAtMilliseconds - clock.currentTimeMillisUnsafe())
      ).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.andThen(
          Effect.sync(() => {
            disposeOwner(registry, resident).catch(() => undefined);
          })
        )
      )
    );
  });

const createOwner = (
  registry: ResidentRegistry,
  catalog: ResidentCatalog,
  clock: Clock.Clock
): ResidentOwner => {
  const server = McpServer.layerHttp({
    name: "fidy",
    version: "0.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
    allowedOrigins: [],
  });

  const ready = Deferred.makeUnsafe<ResidentOwner>();

  const registered = residentRegistration(registry, () => owner, catalog.tools).pipe(
    Effect.andThen(residentLifetime(registry, Deferred.await(ready), clock))
  );

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
  Deferred.doneUnsafe(ready, Effect.succeed(owner));

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
  Effect.forEach(
    registry.owners,
    (owner) =>
      owner.retiring && owner.leases === 0
        ? Effect.tryPromise(() => disposeOwner(registry, owner))
        : Effect.void,
    { discard: true }
  );

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

    if (
      registry.closed ||
      registry.owners.size >= maximumResidentOwners ||
      request.signal.aborted
    ) {
      return Option.none();
    }

    return Option.some(createOwner(registry, catalog, yield* Clock.Clock));
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
          observeRejections: registry.observeRejections,
          subject: catalog.subject,
          scopes: catalog.scopes,
          enqueueCanonicalWork: registry.config.enqueueCanonicalWork,
          signal,
          transportDeadlineMilliseconds: admission.deadlineMilliseconds,
        },
      })
    );

    const request =
      admission.method === "POST"
        ? new Request("https://coordinator.internal/mcp", {
            method: admission.method,
            headers: admission.headers,
            body: new Uint8Array(admission.body),
            signal,
          })
        : new Request("https://coordinator.internal/mcp", {
            method: admission.method,
            headers: admission.headers,
            signal,
          });

    return yield* Effect.tryPromise(() => {
      if (registry.closed || owner.retiring || Option.isSome(owner.disposal)) {
        return Promise.resolve(Option.none<Response>());
      }

      return owner.handler.handler(request, context).then(Option.some);
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
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
    const leased = leasedResponse(owner, response, ticket);
    ticket.transferred = true;
    ticket.settleTransfer();

    return leased;
  });

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
    const live = yield* registry.config.resolveCaller({ subject, current });

    if (Option.isNone(live)) {
      retireBinding(registry, callerBinding(subject));

      return denied();
    }

    const { tools, fingerprint: catalogFingerprint } = yield* catalogTools(live.value.scopes);
    const selectedAt = yield* Clock.currentTimeMillis;

    const expiresAtMilliseconds = Math.min(
      DateTime.toEpochMillis(live.value.credentialExpiresAt),
      DateTime.toEpochMillis(live.value.grantExpiresAt),
      selectedAt + maximumResidentLifetimeMilliseconds
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
      (ticket, exit) => releaseResidentTicket(ticket, Exit.isFailure(exit))
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));

const retireConnections = (
  registry: ResidentRegistry,
  connectionId: Option.Option<string>
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const owner of registry.owners) {
      if (Option.isNone(connectionId) || owner.connectionId === connectionId.value) {
        disposeOwner(registry, owner).catch(() => undefined);
      }
    }
  });

const disposeRegistry = (registry: ResidentRegistry): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    registry.closed = true;

    yield* Effect.forEach(
      registry.owners,
      (owner) => Effect.tryPromise(() => disposeOwner(registry, owner)),
      { discard: true }
    );
  });

export const makeMcpResidency = (config: ResidencyConfig): McpResidency => {
  const registry: ResidentRegistry = {
    config,
    owners: new Set(),
    closed: false,
    observeRejections: coreRejectionObserver(),
  };

  return {
    handle: (request) => handleResidentRequest(registry, request),
    retireConnections: (connectionId) => retireConnections(registry, connectionId),
    dispose: () => disposeRegistry(registry),
    erasureSettled: () => Effect.sync(() => registry.owners.size === 0),
  };
};

export const localProtocolAdmission = Effect.fn(function* (request: Request, subject: OAuthCaller) {
  const body = yield* readBoundedRequestBody(request, bodyPolicy);

  return yield* prepareMcp({ request, lifetimeMilliseconds: requestLifetime(body) }, subject, body);
});
