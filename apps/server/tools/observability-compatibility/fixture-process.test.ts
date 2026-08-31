import { UnknownJsonString, jsonStringSchema } from "~/schema-compatibility";
import { Cause, Context, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { PgLive } from "~/shell/db/client";
import { ProjectedErrorEvent, ProjectedTransaction } from "~/shell/observability/projectors";
import {
  type DurableTraceContext,
  TelemetryAttempt,
  TelemetryHttpStatus,
  TelemetrySpanId,
  TelemetryTraceId,
} from "~/shell/observability/protocol";
import {
  isCurrentSentryClient,
  sentryClientInitializationCount,
} from "~/shell/observability/sentry-adapter";
import { SentryLive } from "~/shell/observability/sentry-live";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";
import {
  type DecodedEnvelopeItem,
  decodeEnvelopeItems,
} from "~/shell/testing/telemetry-envelope-fixtures";
import {
  type TelemetryBootstrap,
  getTelemetryBootstrap,
} from "~/shell/observability/telemetry-bootstrap";
import { getCompatibilityRecorder, requireInstalled } from "./handoff";

const expectedBunVersion = "1.3.14";
const expectedEffectVersion = "4.0.0-rc.112";
const expectedSentryVersion = "10.71.0";
const expectedTraceId = TelemetryTraceId.make("a".repeat(32));
const expectedParentSpanId = TelemetrySpanId.make("b".repeat(16));
const all = (...conditions: ReadonlyArray<boolean>): boolean => conditions.every(Boolean);

const forbiddenSentinels = [
  "compatibility-user-sentinel",
  "compatibility-parameter-sentinel",
  "compatibility-provider-sentinel",
  "compatibility-row-sentinel",
  "compatibility-table-sentinel",
  "compatibility-column-sentinel",
  "pg_catalog.pg_type",
  "sentry-trace",
  "traceparent",
] as const;

const HttpMethod = Schema.Literals(["GET", "POST", "DELETE"]);
type HttpMethod = typeof HttpMethod.Type;

const httpDescriptor = (method: HttpMethod) =>
  ({
    component: "api",
    operation: "http.canonicalRequest",
    trigger: "api",
    spanOperation: "http.server",
    workKind: "http_request",
    metadata: {
      _tag: "Http",
      method,
      route: "/compatibility/:case",
      status: Option.some(TelemetryHttpStatus.make(200)),
    },
  }) as const;

const databaseDescriptor = {
  component: "postgres",
  operation: "postgres.compatibilityProbe",
  trigger: "api",
  spanOperation: "db",
  workKind: "repository_operation",
  metadata: {
    _tag: "Database",
    system: "postgresql",
    repositoryOperation: "compatibility_probe",
  },
} as const;

const providerDescriptor = {
  component: "kapso",
  operation: "provider.request",
  trigger: "api",
  spanOperation: "http.client",
  workKind: "provider_call",
  metadata: {
    _tag: "Provider",
    provider: "kapso",
    attempt: TelemetryAttempt.make(1),
    status: Option.some(TelemetryHttpStatus.make(200)),
  },
} as const;

const expectedOutcomeDescriptor = {
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
} as const;

const WorkspacePackageManifest = Schema.Struct({
  packageManager: Schema.String,
});

const ServerPackageManifest = Schema.Struct({
  dependencies: Schema.Struct({
    effect: Schema.String,
    "@sentry/bun": Schema.String,
  }),
});

const CompatibilityResponse = Schema.Struct({
  traceId: TelemetryTraceId,
  requestMethod: HttpMethod,
  routeOutcome: Schema.Literals([
    "/compatibility/representative",
    "/compatibility/absent",
    "/compatibility/untrusted",
  ]),
  typedOutcome: Schema.Literals(["expected-typed-outcome", "not-exercised"]),
});
type CompatibilityResponse = typeof CompatibilityResponse.Type;

const traceHeaderPattern = /^([0-9a-f]{32})-([0-9a-f]{16})-1$/u;

const trustedContext = (request: Request): Option.Option<DurableTraceContext> => {
  if (request.headers.get("x-fidy-trusted-context") !== "browser") return Option.none();
  const match = traceHeaderPattern.exec(request.headers.get("sentry-trace") ?? "");
  if (match === null) return Option.none();
  return Option.some({
    version: 1,
    traceId: TelemetryTraceId.make(match[1] ?? ""),
    parentSpanId: TelemetrySpanId.make(match[2] ?? ""),
    sampled: true,
    capturedAtUnixMilliseconds: Date.now(),
  });
};

const decodedPayloads = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  items: ReadonlyArray<DecodedEnvelopeItem>
): ReadonlyArray<Decoded> =>
  items.flatMap(({ payload }) => Option.toArray(Schema.decodeUnknownOption(schema)(payload)));

const startServer = (
  fetch: (request: Request) => Response | Promise<Response>
): Effect.Effect<ReturnType<typeof Bun.serve>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true))
  );

const exerciseRepresentativeWork = (
  telemetry: TelemetryService,
  providerUrl: string
): Effect.Effect<"expected-typed-outcome", SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* telemetry.span(
      databaseDescriptor,
      Effect.as(
        sql`
          SELECT ${"compatibility-row-sentinel"}::text AS compatibility_column_sentinel
          FROM pg_catalog.pg_type AS compatibility_table_sentinel
          WHERE typname = 'bool'
            AND ${"compatibility-parameter-sentinel"}::text = ${"compatibility-parameter-sentinel"}
          LIMIT 1
        `,
        undefined
      )
    );
    yield* telemetry.span(
      providerDescriptor,
      Effect.promise(() =>
        fetch(`${providerUrl}compatibility-provider-sentinel`, {
          headers: { "x-provider-token": "compatibility-parameter-sentinel" },
        })
      )
    );
    const expected = yield* Effect.exit(
      telemetry.span(expectedOutcomeDescriptor, Effect.fail("expected-typed-outcome"))
    );
    if (
      !Exit.isFailure(expected) ||
      !Option.contains(Cause.findErrorOption(expected.cause), "expected-typed-outcome")
    ) {
      return yield* Effect.die("typed outcome changed");
    }
    yield* telemetry.captureFailure({
      _tag: "Defect",
      component: "api",
      operation: "http.canonicalRequest",
      error: "unexpected_defect",
      cause: new Error("compatibility-defect-sentinel"),
    });
    return "expected-typed-outcome" as const;
  });

const responseScopesAreIsolated = (
  responses: ReadonlyArray<CompatibilityResponse>,
  roots: ReadonlyArray<ProjectedTransaction>
): boolean =>
  responses.every((response) =>
    roots.some(
      (root) =>
        root.contexts.trace.trace_id === response.traceId &&
        root.contexts.trace.data["http.request.method"] === response.requestMethod
    )
  );

const applicationOutcomeIsPreserved = (responses: ReadonlyArray<CompatibilityResponse>): boolean =>
  all(
    responses.length === 3,
    responses[0]?.routeOutcome === "/compatibility/representative",
    responses[0]?.typedOutcome === "expected-typed-outcome",
    responses[1]?.routeOutcome === "/compatibility/absent",
    responses[1]?.typedOutcome === "not-exercised",
    responses[2]?.routeOutcome === "/compatibility/untrusted",
    responses[2]?.typedOutcome === "not-exercised"
  );

const enabledBootstrap = (): Extract<TelemetryBootstrap, { readonly _tag: "Enabled" }> => {
  const bootstrap = requireInstalled(getTelemetryBootstrap());
  if (bootstrap._tag !== "Enabled") throw new Error("compatibility client was not enabled");
  return bootstrap;
};

const workspacePackageManifest = new URL("../../../../package.json", import.meta.url);
const serverPackageManifest = new URL("../../package.json", import.meta.url);

const fixture = Effect.scoped(
  Effect.gen(function* () {
    const [workspacePackageManifestText, serverPackageManifestText] = yield* Effect.promise(() =>
      Promise.all([
        Bun.file(workspacePackageManifest).text(),
        Bun.file(serverPackageManifest).text(),
      ])
    );
    const packageManifest = yield* Schema.decodeEffect(jsonStringSchema(WorkspacePackageManifest))(
      workspacePackageManifestText
    );
    const serverManifest = yield* Schema.decodeEffect(jsonStringSchema(ServerPackageManifest))(
      serverPackageManifestText
    );
    const recorder = getCompatibilityRecorder();
    const bootstrap = enabledBootstrap();

    const services = yield* Layer.build(Layer.merge(SentryLive, PgLive));
    const telemetry = Context.get(services, Telemetry);
    const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
      Effect.runPromise(Effect.provide(work, services));
    const providerHeaders: Array<Headers> = [];
    const provider = yield* startServer((request) => {
      providerHeaders.push(new Headers(request.headers));
      return new Response("compatibility-provider-sentinel");
    });

    const inbound = yield* startServer(async (request) => {
      const url = new URL(request.url);
      const requestMethod = Schema.decodeUnknownSync(HttpMethod)(request.method);
      const work = Effect.gen(function* () {
        const active = yield* telemetry.captureDurableContext;
        const typedOutcome = yield* url.pathname === "/compatibility/representative"
          ? exerciseRepresentativeWork(telemetry, String(provider.url))
          : Effect.as(Effect.sleep("10 millis"), "not-exercised" as const);
        return new Response(
          JSON.stringify({
            traceId: Option.getOrThrow(active).traceId,
            requestMethod,
            routeOutcome: url.pathname,
            typedOutcome,
          }),
          { headers: { "content-type": "application/json" } }
        );
      });
      return run(
        Option.match(trustedContext(request), {
          onNone: () => telemetry.span(httpDescriptor(requestMethod), work),
          onSome: (parent) => telemetry.continueSpan(parent, httpDescriptor(requestMethod), work),
        })
      );
    });

    const requests = [
      fetch(`${String(inbound.url)}compatibility/representative?user=compatibility-user-sentinel`, {
        headers: {
          "x-fidy-trusted-context": "browser",
          "sentry-trace": `${String(expectedTraceId)}-${String(expectedParentSpanId)}-1`,
        },
      }),
      fetch(`${String(inbound.url)}compatibility/absent`, { method: "POST" }),
      fetch(`${String(inbound.url)}compatibility/untrusted`, {
        method: "DELETE",
        headers: { "sentry-trace": `${"c".repeat(32)}-${"d".repeat(16)}-1` },
      }),
    ];
    const responses = yield* Effect.promise(() =>
      Promise.all(requests).then((values) =>
        Promise.all(
          values.map(async (response) =>
            Schema.decodeUnknownSync(CompatibilityResponse)(await response.json())
          )
        )
      )
    );
    const envelopes = yield* recorder.serializedEnvelopes;
    const items = envelopes.flatMap(decodeEnvelopeItems);
    const transactions = decodedPayloads(ProjectedTransaction, items);
    const errors = decodedPayloads(ProjectedErrorEvent, items);
    const roots = transactions.filter(
      (transaction) => transaction.contexts.trace.op === "http.server"
    );
    const database = transactions.filter((transaction) => transaction.contexts.trace.op === "db");
    const providers = transactions.filter(
      (transaction) => transaction.contexts.trace.op === "http.client"
    );
    const trustedRoot = roots.find(
      (transaction) => transaction.contexts.trace.trace_id === expectedTraceId
    );
    const responseTraceIds = responses.map((response) => response.traceId);
    const propagatedHeaderNames = [
      "sentry-trace",
      "baggage",
      "traceparent",
      "tracestate",
      "b3",
      "x-b3-traceid",
      "x-b3-spanid",
    ];
    const serialized = envelopes.map((value) => new TextDecoder().decode(value)).join("\n");
    const envelopeHeaders = envelopes.map((value) =>
      Schema.decodeSync(UnknownJsonString)(new TextDecoder().decode(value).split("\n")[0] ?? "null")
    );
    const sdkPinned = envelopeHeaders.every((header) =>
      Schema.encodeUnknownSync(UnknownJsonString)(header).includes(
        `"version":"${expectedSentryVersion}"`
      )
    );

    return {
      runtimePinned: all(
        Bun.version === expectedBunVersion,
        packageManifest.packageManager === `bun@${expectedBunVersion}`,
        serverManifest.dependencies.effect === expectedEffectVersion,
        serverManifest.dependencies["@sentry/bun"] === expectedSentryVersion
      ),
      onePreloadedClient: all(
        bootstrap.client === recorder.client,
        isCurrentSentryClient(recorder.client),
        sentryClientInitializationCount() === 1
      ),
      oneRootPerRequest: roots.length === requests.length,
      boundedRootName: roots.every(
        (root) =>
          root.transaction ===
          `${root.contexts.trace.data["http.request.method"]} /compatibility/:case`
      ),
      trustedContextContinued: all(
        trustedRoot?.contexts.trace.parent_span_id === expectedParentSpanId,
        responseTraceIds[0] === expectedTraceId
      ),
      safeRootsStarted: all(
        responseTraceIds[1] !== expectedTraceId,
        responseTraceIds[2] !== expectedTraceId,
        responseTraceIds[1] !== responseTraceIds[2]
      ),
      concurrentScopesIsolated: all(
        new Set(responseTraceIds).size === requests.length,
        database[0]?.contexts.trace.trace_id === expectedTraceId,
        providers[0]?.contexts.trace.trace_id === expectedTraceId,
        providers[0]?.contexts.trace.parent_span_id === trustedRoot?.contexts.trace.span_id,
        responseScopesAreIsolated(responses, roots)
      ),
      oneDatabaseSpan: all(
        database.length === 1,
        database[0]?.transaction === "postgres.compatibilityProbe"
      ),
      databaseMetadataSafe: forbiddenSentinels.every((sentinel) => !serialized.includes(sentinel)),
      typedOutcomeIgnored: errors.length === 1,
      defectCapturedOnce: all(
        errors.length === 1,
        errors[0]?.exception.values[0].type === "FidyDefect"
      ),
      atMostOneProviderSpan: providers.length === 1,
      providerPropagationAbsent: providerHeaders.every((headers) =>
        propagatedHeaderNames.every((name) => !headers.has(name))
      ),
      envelopesProjected: all(
        items.length === transactions.length + errors.length,
        forbiddenSentinels.every((sentinel) => !serialized.includes(sentinel))
      ),
      applicationOutcome: applicationOutcomeIsPreserved(responses),
      sdkPinned,
    };
  })
);

const startedAt = performance.now();
const report = await Effect.runPromise(fixture);
process.stdout.write(
  `FIDY_COMPATIBILITY_REPORT=${JSON.stringify({ ...report, elapsedMilliseconds: performance.now() - startedAt })}\n`
);
if (process.env["FIDY_COMPATIBILITY_PROCESS_OUTCOME"] === "failing") process.exitCode = 23;
