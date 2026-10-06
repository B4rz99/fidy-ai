import { Config, Data, Effect, Option, Schema } from "effect";

class HostFixtureFailure extends Data.TaggedError("HostFixtureFailure")<{ cause: unknown }> {}
const hostPort = 19488;
const maximumTraceEntries = 256;
/** Disposable bridge setup still traverses public ingress, Core, canonical admission and D1. */
type HostFixture = Readonly<{
  db: D1Database;
  send: (path: string, init?: RequestInit) => Promise<Response>;
  bearer: string;
  id: string;
}>;
const Capabilities = Schema.Struct({
  elicitation: Schema.optionalKey(Schema.Struct({ form: Schema.optionalKey(Schema.Struct({})) })),
});
const ClientInfo = Schema.Struct({ name: Schema.String });
const Metadata = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(
      Schema.Struct({
        _meta: Schema.optionalKey(
          Schema.Struct({
            "io.modelcontextprotocol/clientInfo": Schema.optionalKey(ClientInfo),
            "io.modelcontextprotocol/clientCapabilities": Schema.optionalKey(Capabilities),
          })
        ),
        protocolVersion: Schema.optionalKey(Schema.String),
        capabilities: Schema.optionalKey(Capabilities),
        clientInfo: Schema.optionalKey(ClientInfo),
        name: Schema.optionalKey(Schema.String),
        requestState: Schema.optionalKey(Schema.String),
        inputResponses: Schema.optionalKey(
          Schema.Struct({ review: Schema.Struct({ action: Schema.String }) })
        ),
      })
    ),
    result: Schema.optionalKey(Schema.Struct({ action: Schema.optionalKey(Schema.String) })),
  })
);
type Metadata = typeof Metadata.Type;
type Trace = Readonly<{
  method: string;
  tool: string;
  action: string;
  continuation: boolean;
  advertisedForm: boolean;
  declaredClient: string;
  offeredProtocol: string;
  protocolHeader: string;
  negotiatedProtocol: string;
  httpStatus: number;
}>;
type BridgeState = {
  fixture: HostFixture;
  trace: Array<Trace>;
  finished: ReturnType<typeof Promise.withResolvers<void>>;
};
const decisionAction = (metadata: Metadata): string =>
  metadata.params?.inputResponses?.review.action ?? metadata.result?.action ?? "";
const clientName = (metadata: Metadata): string =>
  metadata.params?._meta?.["io.modelcontextprotocol/clientInfo"]?.name ??
  metadata.params?.clientInfo?.name ??
  "";
const advertisedForm = (metadata: Metadata): boolean => {
  const capabilities =
    metadata.params?._meta?.["io.modelcontextprotocol/clientCapabilities"] ??
    metadata.params?.capabilities;
  return capabilities?.elicitation?.form !== undefined;
};
const traceMetadata = (body: string): Option.Option<Trace> =>
  Schema.decodeOption(Metadata)(body).pipe(
    Option.map((metadata) => ({
      method: metadata.method ?? "response",
      tool: metadata.params?.name ?? "",
      action: decisionAction(metadata),
      continuation: metadata.params?.requestState !== undefined,
      advertisedForm: advertisedForm(metadata),
      declaredClient: clientName(metadata),
      offeredProtocol: metadata.params?.protocolVersion ?? "",
      protocolHeader: "",
      negotiatedProtocol: "",
      httpStatus: 0,
    }))
  );
const wait = <A>(work: () => Promise<A>): Effect.Effect<A, HostFixtureFailure> =>
  Effect.tryPromise({ try: work, catch: (cause) => new HostFixtureFailure({ cause }) });
const appendTrace = (
  input: Readonly<{
    state: BridgeState;
    request: Request;
    response: Response;
    metadata: Option.Option<Trace>;
  }>
): void => {
  const { state, request, response, metadata } = input;
  if (state.trace.length >= maximumTraceEntries) {
    return;
  }
  const entry = Option.getOrElse(metadata, () => ({
    method: request.method,
    tool: "",
    action: "",
    continuation: false,
    advertisedForm: false,
    declaredClient: "",
    offeredProtocol: "",
    protocolHeader: "",
    negotiatedProtocol: "",
    httpStatus: 0,
  }));
  state.trace.push({
    ...entry,
    httpStatus: response.status,
    protocolHeader: request.headers.get("mcp-protocol-version") ?? "",
    negotiatedProtocol: response.headers.get("mcp-protocol-version") ?? "",
  });
};
const forward = (
  state: BridgeState,
  request: Request
): Effect.Effect<Response, HostFixtureFailure> =>
  Effect.gen(function* () {
    const headers = new Headers(request.headers);
    // Only this fixture holds the disposable, genuinely approved OAuth credential; it is never
    // put in model context. Ingress validates the real credential on every forwarded request.
    headers.set("authorization", `Bearer ${state.fixture.bearer}`);
    const body =
      request.method === "POST"
        ? Option.some(yield* wait(() => request.text()))
        : Option.none<string>();
    const metadata = Option.flatMap(body, traceMetadata);
    const response = yield* wait(() =>
      state.fixture.send(`/mcp${new URL(request.url).search}`, {
        method: request.method,
        headers,
        signal: request.signal,
        ...(Option.isSome(body) ? { body: body.value } : {}),
      })
    );
    appendTrace({ state, request, response, metadata });
    return response;
  });
const status = (state: BridgeState): Effect.Effect<Response, HostFixtureFailure> =>
  Effect.gen(function* () {
    const remaining = yield* wait(() =>
      state.fixture.db
        .prepare("SELECT count(*) FROM budgets WHERE id = ?")
        .bind(state.fixture.id)
        .first<number>("count(*)")
    );
    const accepted = yield* wait(() =>
      state.fixture.db
        .prepare(
          "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
        )
        .first<number>("count(*)")
    );
    return Response.json({ budgetId: state.fixture.id, remaining, accepted, trace: state.trace });
  });
const route = <E>(
  state: BridgeState,
  setup: () => Effect.Effect<HostFixture, E>,
  request: Request
): Effect.Effect<Response, E | HostFixtureFailure> =>
  Effect.gen(function* () {
    switch (new URL(request.url).pathname) {
      case "/reset":
        state.fixture = yield* setup();
        state.trace.length = 0;
        return Response.json({ budgetId: state.fixture.id });
      case "/status":
        return yield* status(state);
      case "/finish":
        state.finished.resolve();
        return Response.json({ finished: true });
      case "/mcp":
        return yield* forward(state, request);
      default:
        return new Response(null, { status: 404 });
    }
  });
export const nativeHostBridgeFile = Effect.runSync(
  Config.option(Config.String("FIDY_988_HOST_BRIDGE_FILE"))
);
const Ready = Schema.fromJsonString(
  Schema.Struct({ port: Schema.Finite, budgetId: Schema.String })
);
const awaitHost = (
  bridge: Bun.Server<unknown>,
  state: BridgeState
): Effect.Effect<void, HostFixtureFailure> =>
  Effect.gen(function* () {
    const ready = yield* Schema.encodeEffect(Ready)({
      port: bridge.port ?? hostPort,
      budgetId: state.fixture.id,
    }).pipe(Effect.mapError((cause) => new HostFixtureFailure({ cause })));
    yield* wait(() => Bun.write(Option.getOrThrow(nativeHostBridgeFile), ready));
    yield* wait(() => state.finished.promise);
  });
/** Opt-in loopback-only exact-host evidence, not a product authentication or alternate tool path. */
export const runNativeHostFixture = <E>(
  setup: () => Effect.Effect<HostFixture, E>
): Effect.Effect<void, E | HostFixtureFailure> =>
  Effect.gen(function* () {
    const state: BridgeState = {
      fixture: yield* setup(),
      trace: [],
      finished: Promise.withResolvers<void>(),
    };
    const context = yield* Effect.context<never>();
    const fetch = (request: Request): Promise<Response> =>
      Effect.runPromiseWith(context)(route(state, setup, request));
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({ hostname: "127.0.0.1", port: hostPort, idleTimeout: 255, fetch })
      ),
      (bridge) => awaitHost(bridge, state),
      (bridge) => wait(() => bridge.stop(false)).pipe(Effect.orDie)
    );
  });
