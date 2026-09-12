import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import {
  type Array,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Redacted,
  type Scope,
  Tracer,
} from "effect";
import { RunnerAddress } from "effect/unstable/cluster";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import { expectNotInspected, renderedFailure } from "~/shell/testing/credential-failure";
import { authenticatedRunnerMiddleware } from "./authenticated-cluster-http";
import {
  type ClusterRunnerPorts,
  type ClusterToken,
  boundRunnerRpcProtocol,
  clusterRunnerPath,
  isConfiguredRunnerDestination,
  makeClusterRunnerHttpClient,
  runnerRequestUrl,
} from "./cluster-runner-http";

const tokenFixture = "a1b2c3d4".repeat(8);
const token = Redacted.make(tokenFixture);
const otherTokenFixture = "b".repeat(64);
// The first byte of a MessagePack array frame: enough to flush response headers, incomplete
// enough that the RPC parser buffers it and keeps waiting for the rest of the exchange.
const partialMessagePackFrame = new Uint8Array([0x91]);

type RunnerHandler = (request: Request) => Response | Promise<Response>;

type CapturedRequest = Readonly<{
  readonly url: string;
  readonly authorization: Option.Option<string>;
}>;

type TestServer = Readonly<{
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly requests: Array<CapturedRequest>;
  readonly stop: Effect.Effect<void>;
}>;

type RunnerClientOptions = Readonly<{
  readonly runnerHosts: Array.NonEmptyArray<string>;
  readonly runnerPorts: ClusterRunnerPorts;
  readonly deadline: Duration.Input;
  readonly token: ClusterToken;
}>;

const makeTestServer = (handle: RunnerHandler): TestServer => {
  const requests: Array<CapturedRequest> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push({
        url: request.url,
        authorization: Option.fromNullishOr(request.headers.get("authorization")),
      });
      return handle(request);
    },
  });
  return {
    host: "127.0.0.1",
    port: Number(server.url.port),
    origin: `http://127.0.0.1:${server.url.port}`,
    requests,
    stop: Effect.promise(() => server.stop(true)),
  };
};

const withTestServer = <A, E, R>(
  handle: RunnerHandler,
  use: (server: TestServer) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeTestServer(handle)),
    use,
    (server) => server.stop
  );

const runnerClientOptions = (
  server: TestServer,
  overrides: Partial<RunnerClientOptions> = {}
): RunnerClientOptions => ({
  runnerHosts: [server.host],
  runnerPorts: { _tag: "Configured", ports: [server.port] },
  deadline: "5 seconds",
  token,
  ...overrides,
});

const configuredRunnerClientFrom = (
  address: RunnerAddress.RunnerAddress,
  options: RunnerClientOptions
): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  Effect.map(Layer.build(FetchHttpClient.layer), (context) =>
    makeClusterRunnerHttpClient({
      client: Context.get(context, HttpClient.HttpClient),
      token: options.token,
      address,
      runnerHosts: options.runnerHosts,
      runnerPorts: options.runnerPorts,
    })
  );

const configuredRunnerClient = (
  server: TestServer,
  overrides: Partial<RunnerClientOptions> = {}
): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  configuredRunnerClientFrom(
    RunnerAddress.make(server.host, server.port),
    runnerClientOptions(server, overrides)
  );

const ProbeRpcs = RpcGroup.make(Rpc.make("Probe"));

const makeBoundedProbeProtocol = (
  client: HttpClient.HttpClient,
  deadline: Duration.Input
): Effect.Effect<RpcClient.Protocol["Service"]> =>
  RpcClient.makeProtocolHttp(client).pipe(
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.msgPack),
    Effect.map((protocol) => boundRunnerRpcProtocol({ protocol, deadline }))
  );

const probeProtocol = (
  protocol: RpcClient.Protocol["Service"]
): Effect.Effect<Exit.Exit<void, RpcClientError.RpcClientError>, never, Scope.Scope> =>
  Effect.exit(
    Effect.provideService(
      Effect.scoped(
        Effect.flatMap(
          RpcClient.make(ProbeRpcs, { spanPrefix: "Probe", disableTracing: true }),
          (rpc) => rpc.Probe()
        )
      ),
      RpcClient.Protocol,
      protocol
    )
  );

const probeRunner = (
  server: TestServer,
  overrides: Partial<RunnerClientOptions> = {}
): Effect.Effect<Exit.Exit<void, RpcClientError.RpcClientError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const options = runnerClientOptions(server, overrides);
    const client = yield* configuredRunnerClientFrom(
      RunnerAddress.make(server.host, server.port),
      options
    );
    const protocol = yield* makeBoundedProbeProtocol(client, options.deadline);
    return yield* probeProtocol(protocol);
  });

/** Proves neither an inspector nor a serialized rendering can recover any given secret. */
const expectSecretsAbsent = (value: unknown, secrets: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function* () {
    expectNotInspected(value, ...secrets);
    const rendered = yield* renderedFailure(value).pipe(Effect.orDie);
    for (const secret of secrets) expect(rendered).not.toContain(secret);
  });

const projectedRunnerUrl = `http://cluster.invalid${clusterRunnerPath}`;

const projectedRunnerRequest = (): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.make("POST")(projectedRunnerUrl);

/** The whole HTTP client failure the private runner contract promises for one projected reason. */
const expectedHttpFailure = (
  reason: HttpClientError.HttpClientErrorReason
): HttpClientError.HttpClientError => new HttpClientError.HttpClientError({ reason });

/** The whole RPC failure the private runner protocol promises for one projected HTTP reason. */
const expectedHttpRpcFailure = (
  reason: HttpClientError.HttpClientErrorReason
): RpcClientError.RpcClientError =>
  RpcClientError.RpcClientError.make({
    reason: HttpClientError.HttpClientErrorSchema.make({
      _tag: "HttpError",
      kind: reason._tag,
      cause: reason,
    }),
  });

const expectedTransportHttpFailure = (): HttpClientError.HttpClientError =>
  expectedHttpFailure(new HttpClientError.TransportError({ request: projectedRunnerRequest() }));

const expectedInvalidUrlHttpFailure = (): HttpClientError.HttpClientError =>
  expectedHttpFailure(new HttpClientError.InvalidUrlError({ request: projectedRunnerRequest() }));

const expectedTransportRpcFailure = (): RpcClientError.RpcClientError =>
  expectedHttpRpcFailure(new HttpClientError.TransportError({ request: projectedRunnerRequest() }));

const expectedInvalidUrlRpcFailure = (): RpcClientError.RpcClientError =>
  expectedHttpRpcFailure(
    new HttpClientError.InvalidUrlError({ request: projectedRunnerRequest() })
  );

const expectedDecodeRpcFailure = (): RpcClientError.RpcClientError =>
  expectedHttpRpcFailure(
    new HttpClientError.DecodeError({
      request: projectedRunnerRequest(),
      response: HttpClientResponse.fromWeb(
        projectedRunnerRequest(),
        new Response(null, { status: 200 })
      ),
    })
  );

const expectedProtocolDefectRpcFailure = (): RpcClientError.RpcClientError =>
  RpcClientError.RpcClientError.make({
    reason: RpcClientError.RpcClientDefect.make({
      message: "Runner RPC protocol failed",
      cause: undefined,
    }),
  });

/** Proves a whole HTTP client failure equals the projected contract and leaks no secret. */
const expectHttpFailure = <A>(
  exit: Exit.Exit<A, HttpClientError.HttpClientError>,
  expected: HttpClientError.HttpClientError,
  secrets: ReadonlyArray<string>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    assert.deepStrictEqual(exit, Exit.fail(expected));
    if (Exit.isFailure(exit)) yield* expectSecretsAbsent(exit.cause, secrets);
  });

/** Proves a whole runner RPC failure equals the projected contract and leaks no secret. */
const expectRunnerRpcFailure = (
  exit: Exit.Exit<void, RpcClientError.RpcClientError>,
  expected: RpcClientError.RpcClientError,
  secrets: ReadonlyArray<string>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    assert.deepStrictEqual(exit, Exit.fail(expected));
    if (Exit.isFailure(exit)) yield* expectSecretsAbsent(exit.cause, secrets);
  });

const assertAuthenticatedRunnerRequest = (
  server: TestServer
): Effect.Effect<void, HttpClientError.HttpClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* configuredRunnerClient(server);
    const response = yield* client.post("");
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual({ status: "ok" });
    expect(server.requests).toEqual([
      {
        url: `${server.origin}${clusterRunnerPath}`,
        authorization: Option.some(`Bearer ${tokenFixture}`),
      },
    ]);
  });

const assertRunnerMiddlewareStatuses = (
  server: TestServer
): Effect.Effect<void, HttpClientError.HttpClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const authenticated = yield* configuredRunnerClient(server);
    const accepted = yield* authenticated.post("");
    expect(accepted.status).toBe(200);
    expect(yield* accepted.text).toBe("accepted");

    const unauthenticated = yield* configuredRunnerClient(server, {
      token: Redacted.make(otherTokenFixture),
    });
    const refused = yield* unauthenticated.post("");
    expect(refused.status).toBe(401);
    expect(yield* refused.text).toBe("");

    expect(server.requests.map((request) => request.authorization)).toEqual([
      Option.some(`Bearer ${tokenFixture}`),
      Option.some(`Bearer ${otherTokenFixture}`),
    ]);
  });

const assertDestinationRefusal = (server: TestServer): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* configuredRunnerClient(server, { runnerHosts: ["runner.internal"] });
    const exit = yield* Effect.exit(client.post(""));
    expect(server.requests).toHaveLength(0);
    yield* expectHttpFailure(exit, expectedInvalidUrlHttpFailure(), [tokenFixture, server.origin]);
  });

const redirectingHandler =
  (target: TestServer): RunnerHandler =>
  () =>
    Response.redirect(`${target.origin}/stolen`, 302);

const assertRedirectRefusal =
  (target: TestServer) =>
  (redirector: TestServer): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const client = yield* configuredRunnerClient(redirector);
      const exit = yield* Effect.exit(client.post(""));
      expect(redirector.requests).toHaveLength(1);
      expect(target.requests).toHaveLength(0);
      yield* expectHttpFailure(exit, expectedTransportHttpFailure(), [tokenFixture, target.origin]);
    });

const stalledHandler =
  (services: Context.Context<never>, stalled: Deferred.Deferred<Response>): RunnerHandler =>
  () =>
    Effect.runPromiseWith(services)(Deferred.await(stalled));

const assertExchangeDeadline = (
  server: TestServer,
  deadline: Duration.Input
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const exit = yield* probeRunner(server, { deadline });
    expect(server.requests).toHaveLength(1);
    yield* expectRunnerRpcFailure(exit, expectedTransportRpcFailure(), [
      tokenFixture,
      server.origin,
    ]);
  });

const stalledBodyHandler =
  (services: Context.Context<never>, release: Deferred.Deferred<void>): RunnerHandler =>
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(partialMessagePackFrame);
        },
        pull: (controller) =>
          Effect.runPromiseWith(services)(
            Effect.flatMap(Deferred.await(release), () =>
              // The client aborts the stalled exchange first; closing is best effort.
              Effect.exit(Effect.sync(() => controller.close()))
            )
          ).then(() => undefined),
      })
    );

/** Enqueues a partial frame so response headers flush, then leaves the body open. */
const openBodyHandler = (): RunnerHandler => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partialMessagePackFrame);
      },
    })
  );

const assertBodyFailureProjected = (server: TestServer): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const client = yield* configuredRunnerClient(server);
    const observed = HttpClient.transform(client, (responseEffect) =>
      Effect.tap(responseEffect, () => Deferred.succeed(acquired, undefined))
    );
    const protocol = yield* makeBoundedProbeProtocol(observed, "5 seconds");
    const probe = yield* Effect.forkChild(probeProtocol(protocol));
    yield* Deferred.await(acquired);
    // Dropping the connection after headers, inside the body, produces a real response-stream
    // failure whose raw reason still carries the credentialed request.
    yield* server.stop;
    const outcome = yield* Fiber.join(probe);
    expect(server.requests).toHaveLength(1);
    yield* expectRunnerRpcFailure(outcome, expectedDecodeRpcFailure(), [
      tokenFixture,
      server.origin,
    ]);
  });

const assertDestinationRefusalThroughRpc = (
  server: TestServer
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const exit = yield* probeRunner(server, { runnerHosts: ["runner.internal"] });
    expect(server.requests).toHaveLength(0);
    yield* expectRunnerRpcFailure(exit, expectedInvalidUrlRpcFailure(), [
      tokenFixture,
      server.origin,
    ]);
  });

/** An empty HTTP 200 makes the RPC protocol raise a defect whose raw cause is the encoded request. */
const assertProtocolDefectProjected = (
  server: TestServer
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const exit = yield* probeRunner(server);
    expect(server.requests).toHaveLength(1);
    yield* expectRunnerRpcFailure(exit, expectedProtocolDefectRpcFailure(), [
      tokenFixture,
      server.origin,
    ]);
  });

it.effect("accepts only absolute HTTP URLs on configured runner hosts and ports", () =>
  Effect.sync(() => {
    const allowed = isConfiguredRunnerDestination({
      runnerHosts: ["127.0.0.1", "Runner.internal."],
      runnerPorts: { _tag: "Configured", ports: [8080] },
    });
    expect(allowed("http://127.0.0.1:8080/_fidy/cluster")).toBe(true);
    // The runner transport forms plain HTTP; any other scheme is refused.
    expect(allowed("https://runner.internal:8080/_fidy/cluster")).toBe(false);
    // The configured runner port is the only port the shared credential may reach.
    expect(allowed("http://127.0.0.1:9000/_fidy/cluster")).toBe(false);
    expect(allowed("http://127.0.0.1/_fidy/cluster")).toBe(false);
    expect(allowed("http://10.0.0.7:8080/_fidy/cluster")).toBe(false);
    expect(allowed("http://127.0.0.1.evil.test:8080/_fidy/cluster")).toBe(false);
    expect(allowed("http://user:secret@127.0.0.1:8080/_fidy/cluster")).toBe(false);
    expect(allowed("file://127.0.0.1:8080/_fidy/cluster")).toBe(false);
    expect(allowed("/_fidy/cluster")).toBe(false);

    // Loopback harnesses listen on ephemeral ports and opt into any port explicitly.
    const anyPort = isConfiguredRunnerDestination({
      runnerHosts: ["127.0.0.1"],
      runnerPorts: { _tag: "Any" },
    });
    expect(anyPort("http://127.0.0.1:9000/_fidy/cluster")).toBe(true);
    expect(anyPort("http://127.0.0.1.evil.test:9000/_fidy/cluster")).toBe(false);
  })
);

it.effect("forms a bracketed URL for an IPv6 runner address the allowlist accepts", () =>
  Effect.sync(() => {
    expect(runnerRequestUrl(RunnerAddress.make("::1", 8080))).toBe(
      "http://[::1]:8080/_fidy/cluster"
    );
    expect(runnerRequestUrl(RunnerAddress.make("[::1]", 8080))).toBe(
      "http://[::1]:8080/_fidy/cluster"
    );
    const allowed = isConfiguredRunnerDestination({
      runnerHosts: ["::1"],
      runnerPorts: { _tag: "Configured", ports: [8080] },
    });
    expect(allowed(runnerRequestUrl(RunnerAddress.make("::1", 8080)))).toBe(true);
    expect(allowed("http://[::1]:9000/_fidy/cluster")).toBe(false);
  })
);

it.effect("authenticates a request to the configured private runner route", () =>
  withTestServer(() => Response.json({ status: "ok" }), assertAuthenticatedRunnerRequest)
);

it.effect("passes the real runner middleware with the credential and fails closed without it", () =>
  Effect.gen(function* () {
    const routes = HttpRouter.use((router) =>
      router.add("POST", clusterRunnerPath, Effect.succeed(HttpServerResponse.text("accepted")))
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(routes.pipe(Layer.provide(authenticatedRunnerMiddleware(token))), {
          disableLogger: true,
        })
      ),
      ({ handler }) => withTestServer(handler, assertRunnerMiddlewareStatuses),
      ({ dispose }) => Effect.promise(dispose)
    );
  })
);

it.effect("refuses a destination outside the configured private runner addresses", () =>
  withTestServer(() => Response.json({ ok: true }), assertDestinationRefusal)
);

it.effect("refuses redirects without forwarding the Cluster credential", () =>
  withTestServer(
    () => Response.json({ ok: true }),
    (target) => withTestServer(redirectingHandler(target), assertRedirectRefusal(target))
  )
);

it.live("terminates a stalled runner exchange inside the configured deadline", () =>
  Effect.gen(function* () {
    const stalled = yield* Deferred.make<Response>();
    const services = yield* Effect.context<never>();
    yield* withTestServer(stalledHandler(services, stalled), (server) =>
      Effect.ensuring(
        assertExchangeDeadline(server, "150 millis"),
        Deferred.succeed(stalled, new Response("late"))
      )
    );
  })
);

it.live("bounds the RPC exchange after response headers arrive", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const services = yield* Effect.context<never>();
    yield* withTestServer(stalledBodyHandler(services, release), (server) =>
      Effect.ensuring(
        assertExchangeDeadline(server, "300 millis"),
        Deferred.succeed(release, undefined)
      )
    );
  })
);

it.effect("reports only safe transport metadata when the runner body fails mid-stream", () =>
  withTestServer(openBodyHandler(), assertBodyFailureProjected)
);

it.effect("projects runner protocol defects without the encoded request", () =>
  withTestServer(() => new Response(null, { status: 200 }), assertProtocolDefectProjected)
);

it.effect("classifies unreachable runner transport as a projected transport failure", () =>
  Effect.gen(function* () {
    const server = makeTestServer(() => Response.json({ ok: true }));
    const { origin } = server;
    yield* server.stop;
    const client = yield* configuredRunnerClient(server);
    const exit = yield* Effect.exit(client.post(""));
    yield* expectHttpFailure(exit, expectedTransportHttpFailure(), [tokenFixture, origin]);
  })
);

it.effect("keeps the Cluster credential out of spans and logs for runner exchanges", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logs: Array<string> = [];
    const logger = Logger.make((options) => logs.push(String(options.message)));

    yield* withTestServer(
      () => Response.json({ ok: true }),
      (server) =>
        Effect.gen(function* () {
          const client = yield* configuredRunnerClient(server);
          const response = yield* client
            .post("")
            .pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.withLogger(logger));
          expect(response.status).toBe(200);
        })
    );

    const stopped = makeTestServer(() => Response.json({ ok: true }));
    yield* stopped.stop;
    const failing = yield* configuredRunnerClient(stopped);
    const exit = yield* Effect.exit(failing.post("")).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.withLogger(logger)
    );
    yield* expectHttpFailure(exit, expectedTransportHttpFailure(), [
      tokenFixture,
      otherTokenFixture,
    ]);

    // The transport suppresses the coordinate-bearing automatic client span, so no runner
    // exchange may record a span for the private origin, port, or path; and neither a successful
    // nor a failed exchange may record the bearer in a span or a log record.
    expect(spans).toEqual([]);
    const recorded = logs.join("|");
    expect(recorded).not.toContain(tokenFixture);
    expect(recorded).not.toContain(otherTokenFixture);
  })
);

it.effect("classifies policy refusals through the real runner RPC protocol", () =>
  withTestServer(() => Response.json({ ok: true }), assertDestinationRefusalThroughRpc)
);
