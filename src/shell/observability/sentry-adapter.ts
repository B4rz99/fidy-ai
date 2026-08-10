import * as Sentry from "@sentry/bun";
import { Cause, Clock, Effect, Exit, Function as Fn, Option, Predicate, Schema } from "effect";
import { strictDecoding } from "./decoding";
import {
  type ActiveTraceCoordinates,
  type ProjectedBreadcrumb,
  ProjectedErrorEvent,
  ProjectedTransaction,
  projectBreadcrumb,
  projectErrorEvent,
  projectFinalBreadcrumb,
  projectFinalSpan,
  projectTransaction,
} from "./projectors";
import {
  type ClassifiedFailure,
  DeclaredOutcome,
  type DurableTraceContext,
  SpanDescriptor,
  type TelemetryBreadcrumb,
  type TelemetryHttpStatus,
  type TelemetryModelUsage,
  TelemetrySpanId,
  TelemetryTraceId,
} from "./protocol";
import type {
  EnabledCapture,
  NonProductionTelemetryConfig,
  ProductionTelemetryConfig,
} from "./telemetry-config";
import type { TelemetryAdapter, TelemetryResource, TelemetrySpan } from "./telemetry";

const recordingDsn = "https://public@example.invalid/1";
const recordingRelease = "fidy@0000000000000000000000000000000000000000";
const recordingEnvironment = "local";
const hexRadix = 16;
const traceIdByteLength = 16;
const spanIdByteLength = 8;
const millisecondsPerSecond = 1_000;
/** Reported to the SDK for every recorded and every skipped envelope; nothing leaves the process. */
const acceptedStatusCode = 200;
/** Bounds the wait for the SDK's own queue when reading recorded bytes and when closing. */
const clientDrainMilliseconds = 1_000;
const uint32BitWidth = 32;
const randomUint32Range = 2 ** uint32BitWidth;
const rateLimitedStatusCode = 429;

const castSdkEvent = <SdkEvent extends Sentry.Event>(value: unknown): SdkEvent =>
  Fn.cast<unknown, SdkEvent>(value);

const copyBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body.slice();

/** True only for the two serialized envelope item kinds the metadata-only seam emits. */
export const isSupportedEnvelopeItemType = (
  itemType: unknown
): itemType is "event" | "transaction" => itemType === "event" || itemType === "transaction";

const isSupportedEnvelope = (
  envelope: Parameters<ReturnType<typeof Sentry.createTransport>["send"]>[0]
): boolean => envelope[1].every(([header]) => isSupportedEnvelopeItemType(header.type));

/**
 * The trace coordinates an error event may carry. The SDK attaches these itself, and outside a Span
 * it supplies a trace and span with no operation to name — so `op` is present only when one exists.
 */
type ErrorTraceCoordinates = Pick<
  NonNullable<NonNullable<Sentry.ErrorEvent["contexts"]>["trace"]>,
  "trace_id" | "span_id" | "parent_span_id" | "op"
>;
type ErrorTraceContext = Partial<
  Readonly<{ readonly contexts: Readonly<{ readonly trace: ErrorTraceCoordinates }> }>
>;

const errorTraceContext = (
  trace: NonNullable<Sentry.ErrorEvent["contexts"]>["trace"]
): ErrorTraceContext =>
  trace === undefined
    ? {}
    : {
        contexts: {
          trace: {
            trace_id: trace.trace_id,
            span_id: trace.span_id,
            ...(trace.parent_span_id === undefined ? {} : { parent_span_id: trace.parent_span_id }),
            ...(trace.op === undefined ? {} : { op: trace.op }),
          },
        },
      };

type SentryClientConfig = Readonly<{
  release: string;
  environment: string;
  capture: Readonly<{ errors: boolean; traces: boolean }>;
  errorSampleRate: 1;
  rootTraceRate: number;
}>;

type SentryIdentity = Pick<SentryClientConfig, "release" | "environment">;

const safeErrorEvent = (
  event: Sentry.ErrorEvent,
  identity: SentryIdentity
): Option.Option<Sentry.ErrorEvent> => {
  const values = event.exception?.values;
  const selectedException =
    values === undefined
      ? undefined
      : {
          values: values.map((value) => ({
            type: value.type,
            value: value.value,
            stacktrace: {
              frames: (value.stacktrace?.frames ?? []).map((frame) => ({
                module: frame.module,
                filename: frame.filename,
                function: frame.function,
                lineno: frame.lineno,
                colno: frame.colno,
              })),
            },
          })),
        };
  const projected = Schema.decodeUnknownOption(
    ProjectedErrorEvent,
    strictDecoding
  )({
    timestamp: event.timestamp,
    level: "error",
    exception: selectedException,
    fingerprint: event.fingerprint,
    tags: event.tags,
    ...errorTraceContext(event.contexts?.trace),
  });
  return Option.map(projected, (value) =>
    castSdkEvent<Sentry.ErrorEvent>({
      event_id: event.event_id,
      platform: "javascript",
      release: identity.release,
      environment: identity.environment,
      ...value,
    })
  );
};

type TransactionEvent = Sentry.Event & Readonly<{ readonly type: "transaction" }>;

const safeTransactionEvent = (
  event: TransactionEvent,
  identity: SentryIdentity
): Option.Option<TransactionEvent> => {
  const trace = event.contexts?.trace;
  const projectedSpan = projectFinalSpan({
    data: trace?.data,
    description: event.transaction,
    op: trace?.op,
    parent_span_id: trace?.parent_span_id,
    span_id: trace?.span_id,
    start_timestamp: event.start_timestamp,
    status: trace?.status,
    timestamp: event.timestamp,
    trace_id: trace?.trace_id,
    is_segment: true,
  });
  return Option.flatMap(projectedSpan, (span) => {
    const projected = Schema.decodeUnknownOption(
      ProjectedTransaction,
      strictDecoding
    )({
      type: "transaction",
      transaction: span.description,
      transaction_info: { source: "custom" },
      start_timestamp: span.start_timestamp,
      timestamp: span.timestamp,
      contexts: {
        trace: {
          trace_id: span.trace_id,
          span_id: span.span_id,
          ...(span.parent_span_id === undefined ? {} : { parent_span_id: span.parent_span_id }),
          op: span.op,
          status: span.status,
          data: span.data,
        },
      },
      tags: event.tags,
      breadcrumbs: event.breadcrumbs ?? [],
    });
    return Option.map(projected, (value) =>
      castSdkEvent<TransactionEvent>({
        event_id: event.event_id,
        platform: "javascript",
        release: identity.release,
        environment: identity.environment,
        spans: [],
        ...value,
      })
    );
  });
};

const randomHex = (bytes: number): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(hexRadix).padStart(2, "0")).join("");
};

type ActiveState = {
  descriptor: unknown;
  readonly trace: Omit<ActiveTraceCoordinates, "spanOperation">;
  readonly startedAt: number;
  readonly sampled: boolean;
  readonly breadcrumbs: Array<ProjectedBreadcrumb>;
  outcome: Option.Option<unknown>;
  modelUsage: Option.Option<unknown>;
};

/** The private client state every adapter method needs: where events go, and which spans are live. */
type TelemetrySink = Readonly<{
  readonly scope: Sentry.Scope;
  readonly knownStates: WeakMap<object, ActiveState>;
  readonly capture: Readonly<{ errors: boolean; traces: boolean }>;
  readonly rootTraceRate: number;
  readonly randomUnitInterval: () => number;
}>;

/** Isolated native client resource used by serialized-envelope and runtime compatibility gates. */
export type RecordingClient = Readonly<{
  readonly client: Sentry.BunClient;
  readonly resource: TelemetryResource;
  readonly adapter: TelemetryAdapter;
  readonly serializedEnvelopes: Effect.Effect<ReadonlyArray<Uint8Array>>;
  readonly clear: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}>;

const exitOutcome = (exit: Exit.Exit<unknown, unknown>): DeclaredOutcome => {
  if (Exit.isSuccess(exit)) {
    return DeclaredOutcome.make({ outcome: "succeeded", error: Option.none(), retryable: false });
  }
  if (
    Cause.hasInterrupts(exit.cause) &&
    !Cause.hasDies(exit.cause) &&
    !Cause.hasFails(exit.cause)
  ) {
    return DeclaredOutcome.make({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  return DeclaredOutcome.make({ outcome: "failed", error: Option.none(), retryable: false });
};

const activeState = (
  knownStates: WeakMap<object, ActiveState>,
  span: TelemetrySpan
): Option.Option<ActiveState> =>
  Option.flatMap(Option.liftPredicate(span.state, Predicate.isObjectKeyword), (state) =>
    Option.fromNullishOr(knownStates.get(state))
  );

const capture = (scope: Sentry.Scope, event: ProjectedErrorEvent | ProjectedTransaction): void => {
  scope.captureEvent(Fn.cast<ProjectedErrorEvent | ProjectedTransaction, Sentry.Event>(event));
};

/** Appends the exact serialized bytes of every supported envelope and sends nothing anywhere. */
const makeRecordingTransport = (
  envelopes: Array<Uint8Array>,
  options: Parameters<typeof Sentry.createTransport>[0],
  outcome: RecordingTransportOutcome
): ReturnType<typeof Sentry.createTransport> => {
  const base = Sentry.createTransport(options, (request) => {
    envelopes.push(copyBytes(request.body));
    if (outcome === "failed") return Promise.reject(new Error("recording transport failure"));
    return Promise.resolve({
      statusCode: outcome === "rate-limited" ? rateLimitedStatusCode : acceptedStatusCode,
    });
  });
  return {
    send: (envelope: Parameters<typeof base.send>[0]): ReturnType<typeof base.send> =>
      isSupportedEnvelope(envelope)
        ? base.send(envelope)
        : Promise.resolve({ statusCode: acceptedStatusCode }),
    flush: (timeout?: number): ReturnType<typeof base.flush> => base.flush(timeout),
  };
};

type BunClientOptions = ConstructorParameters<typeof Sentry.BunClient>[0];
type SentryTransport = NonNullable<BunClientOptions["transport"]>;

const finalHooks = (
  config: SentryClientConfig
): Pick<
  BunClientOptions,
  "beforeBreadcrumb" | "beforeSend" | "beforeSendSpan" | "beforeSendTransaction"
> => ({
  beforeSend: (event, hint): ReturnType<NonNullable<BunClientOptions["beforeSend"]>> => {
    try {
      return (hint.attachments?.length ?? 0) === 0
        ? Option.getOrNull(safeErrorEvent(event, config))
        : null;
    } catch {
      return null;
    }
  },
  beforeSendSpan: (span): ReturnType<NonNullable<BunClientOptions["beforeSendSpan"]>> => {
    try {
      return Option.getOrElse(projectFinalSpan(span), () => ({
        data: {},
        span_id: "",
        start_timestamp: 0,
        trace_id: "",
      }));
    } catch {
      return { data: {}, span_id: "", start_timestamp: 0, trace_id: "" };
    }
  },
  beforeSendTransaction: (
    event,
    hint
  ): ReturnType<NonNullable<BunClientOptions["beforeSendTransaction"]>> => {
    try {
      return (hint.attachments?.length ?? 0) === 0
        ? Option.getOrNull(safeTransactionEvent(event, config))
        : null;
    } catch {
      return null;
    }
  },
  beforeBreadcrumb: (breadcrumb): ReturnType<NonNullable<BunClientOptions["beforeBreadcrumb"]>> => {
    try {
      return Option.getOrNull(projectFinalBreadcrumb(breadcrumb));
    } catch {
      return null;
    }
  },
});

const sentryClientOptions = (
  dsn: string,
  config: SentryClientConfig,
  transport: SentryTransport
): BunClientOptions => ({
  // A direct BunClient receives no default integrations. Every pinned collection category and
  // side-stream is nevertheless disabled explicitly so an SDK default cannot widen egress.
  dsn,
  transport,
  stackParser: Sentry.defaultStackParser,
  integrations: [],
  sampleRate: config.capture.errors ? config.errorSampleRate : 0,
  ...(config.capture.traces ? { tracesSampleRate: config.rootTraceRate } : {}),
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  },
  attachStacktrace: false,
  maxBreadcrumbs: 0,
  sendClientReports: false,
  tracePropagationTargets: [],
  propagateTraceparent: false,
  traceLifecycle: "static",
  streamGenAiSpans: false,
  enableLogs: false,
  beforeSendLog: (): ReturnType<NonNullable<BunClientOptions["beforeSendLog"]>> => null,
  enableMetrics: false,
  beforeSendMetric: (): ReturnType<NonNullable<BunClientOptions["beforeSendMetric"]>> => null,
  enhanceFetchErrorMessages: false,
  release: config.release,
  environment: config.environment,
  ...finalHooks(config),
});

let initializedSentryClientCount = 0;

const makeSentryClient = (input: {
  readonly dsn: string;
  readonly config: SentryClientConfig;
  readonly transport: SentryTransport;
  readonly bindCurrentClient: boolean;
}): Sentry.BunClient => {
  const client = new Sentry.BunClient(
    sentryClientOptions(input.dsn, input.config, input.transport)
  );
  if (input.bindCurrentClient) Sentry.setCurrentClient(client);
  client.init();
  initializedSentryClientCount += 1;
  return client;
};

/** Reports how many native clients this adapter initialized in the current process. */
export const sentryClientInitializationCount = (): number => initializedSentryClientCount;

/** Transport outcomes available to deterministic no-network envelope tests. */
export type RecordingTransportOutcome = "accepted" | "rate-limited" | "failed";

type RecordingSentryConfig = Readonly<{
  capture: EnabledCapture;
  rootTraceRate: number;
  randomUnitInterval: () => number;
  transportOutcome: RecordingTransportOutcome;
  bindCurrentClient: boolean;
}>;

const defaultRecordingConfig: RecordingSentryConfig = {
  capture: { errors: true, traces: true },
  rootTraceRate: 1,
  randomUnitInterval: () => 0,
  transportOutcome: "accepted",
  bindCurrentClient: false,
};

const makeRecordingSentryClient = (
  envelopes: Array<Uint8Array>,
  config: RecordingSentryConfig
): Sentry.BunClient =>
  makeSentryClient({
    dsn: recordingDsn,
    config: {
      release: recordingRelease,
      environment: recordingEnvironment,
      capture: config.capture,
      errorSampleRate: 1,
      rootTraceRate: config.rootTraceRate,
    },
    transport: (transportOptions) =>
      makeRecordingTransport(envelopes, transportOptions, config.transportOutcome),
    bindCurrentClient: config.bindCurrentClient,
  });

const startTelemetrySpan = (
  sink: TelemetrySink,
  descriptor: SpanDescriptor,
  parent: Option.Option<DurableTraceContext>
): Effect.Effect<Option.Option<TelemetrySpan>> =>
  sink.capture.traces
    ? Effect.map(Clock.currentTimeMillis, (now) => {
        const decoded = Schema.decodeUnknownOption(SpanDescriptor, strictDecoding)(descriptor);
        if (Option.isNone(decoded)) return Option.none();
        const traceId = Option.match(parent, {
          onNone: () => TelemetryTraceId.make(randomHex(traceIdByteLength)),
          onSome: (context) => context.traceId,
        });
        const sampled = Option.match(parent, {
          onNone: () => sink.randomUnitInterval() < sink.rootTraceRate,
          onSome: (context) => context.sampled,
        });
        const spanId = TelemetrySpanId.make(randomHex(spanIdByteLength));
        const state: ActiveState = {
          descriptor,
          trace: {
            traceId,
            spanId,
            parentSpanId: Option.map(parent, (context) => context.parentSpanId),
          },
          startedAt: now / millisecondsPerSecond,
          sampled,
          breadcrumbs: [],
          outcome: Option.none(),
          modelUsage: Option.none(),
        };
        sink.knownStates.set(state, state);
        return Option.some({ traceId, spanId, sampled, state });
      })
    : Effect.succeed(Option.none());

const finishTelemetrySpan = (
  sink: TelemetrySink,
  span: TelemetrySpan,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    Option.map(
      Option.filter(activeState(sink.knownStates, span), (state) => state.sampled),
      (state) => {
        const projected = projectTransaction({
          descriptor: state.descriptor,
          outcome: Option.getOrElse(state.outcome, () => exitOutcome(exit)),
          traceId: state.trace.traceId,
          spanId: state.trace.spanId,
          parentSpanId: state.trace.parentSpanId,
          startedAt: state.startedAt,
          finishedAt: now / millisecondsPerSecond,
          breadcrumbs: state.breadcrumbs,
          modelUsage: state.modelUsage,
        });
        if (Option.isSome(projected)) capture(sink.scope, projected.value);
      }
    );
  });

const recordSpanOutcome = (
  sink: TelemetrySink,
  span: TelemetrySpan,
  outcome: DeclaredOutcome
): Effect.Effect<void> =>
  Effect.sync(() => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      state.outcome = Option.some(outcome);
    });
  });

const recordModelUsage = (
  sink: TelemetrySink,
  span: TelemetrySpan,
  usage: TelemetryModelUsage
): Effect.Effect<void> =>
  Effect.sync(() => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      state.modelUsage = Option.some(usage);
    });
  });

const recordSpanResponseStatus = (
  sink: TelemetrySink,
  span: TelemetrySpan,
  status: TelemetryHttpStatus
): Effect.Effect<void> =>
  Effect.sync(() => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      const descriptor = Schema.decodeUnknownOption(
        SpanDescriptor,
        strictDecoding
      )(state.descriptor);
      if (
        Option.isSome(descriptor) &&
        (descriptor.value.metadata._tag === "Http" || descriptor.value.metadata._tag === "Provider")
      ) {
        state.descriptor = {
          ...descriptor.value,
          metadata: { ...descriptor.value.metadata, status: Option.some(status) },
        };
      }
    });
  });

const captureTelemetryFailure = (
  sink: TelemetrySink,
  span: Option.Option<TelemetrySpan>,
  failure: ClassifiedFailure
): Effect.Effect<void> =>
  sink.capture.errors
    ? Effect.map(Clock.currentTimeMillis, (now) => {
        const state = Option.flatMap(span, (active) => activeState(sink.knownStates, active));
        const activeTrace = Option.flatMap(state, (current) =>
          Option.map(
            Schema.decodeUnknownOption(SpanDescriptor, strictDecoding)(current.descriptor),
            (descriptor) => ({
              ...current.trace,
              spanOperation: descriptor.spanOperation,
            })
          )
        );
        const projected = projectErrorEvent({
          failure,
          timestamp: now / millisecondsPerSecond,
          activeTrace,
        });
        if (Option.isSome(projected)) capture(sink.scope, projected.value);
      })
    : Effect.void;

const addTelemetryBreadcrumb = (
  sink: TelemetrySink,
  span: TelemetrySpan,
  breadcrumb: TelemetryBreadcrumb
): Effect.Effect<void> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      const projected = projectBreadcrumb({
        breadcrumb,
        timestamp: now / millisecondsPerSecond,
      });
      if (Option.isSome(projected)) state.breadcrumbs.push(projected.value);
    });
  });

const randomUnitInterval = (): number => {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return (values[0] ?? 0) / randomUint32Range;
};

const telemetryAdapter = (
  client: Sentry.BunClient,
  config: Pick<SentryClientConfig, "capture" | "rootTraceRate">,
  random: () => number
): TelemetryAdapter => {
  const scope = new Sentry.Scope();
  scope.setClient(client);
  const sink: TelemetrySink = {
    scope,
    knownStates: new WeakMap(),
    capture: config.capture,
    rootTraceRate: config.rootTraceRate,
    randomUnitInterval: random,
  };
  return {
    startSpan: (descriptor, parent) => startTelemetrySpan(sink, descriptor, parent),
    finishSpan: (span, exit) => finishTelemetrySpan(sink, span, exit),
    recordOutcome: (span, outcome) => recordSpanOutcome(sink, span, outcome),
    recordResponseStatus: (span, status) => recordSpanResponseStatus(sink, span, status),
    captureFailure: (span, failure) => captureTelemetryFailure(sink, span, failure),
    addBreadcrumb: (span, breadcrumb) => addTelemetryBreadcrumb(sink, span, breadcrumb),
    recordModelUsage: (span, usage) => recordModelUsage(sink, span, usage),
  };
};

const makeNetworkTransport: SentryTransport = (options) => {
  const transport = Sentry.makeFetchTransport(options);
  return {
    send: (envelope) =>
      isSupportedEnvelope(envelope)
        ? transport.send(envelope)
        : Promise.resolve({ statusCode: acceptedStatusCode }),
    flush: (timeout) => transport.flush(timeout),
  };
};

/** Reports whether runtime assembly still sees the exact client bound by early preload. */
export const isCurrentSentryClient = (client: Sentry.BunClient): boolean =>
  Sentry.getClient() === client;

/** Validated enabled configuration accepted by the preload-owned Sentry client. */
export type SentryTelemetryConfig = ProductionTelemetryConfig | NonProductionTelemetryConfig;

/** The one native client and resource installed by preload for runtime assembly. */
export type SentryTelemetry = Readonly<{
  client: Sentry.BunClient;
  resource: TelemetryResource;
}>;

type CloseTelemetryClient = <E>(
  close: (timeoutMilliseconds: number) => Effect.Effect<boolean, E>
) => Effect.Effect<void>;

/** Bounds and contains client draining so shutdown cannot retry forever or fail the application. */
export const closeTelemetryClient: CloseTelemetryClient = (close) =>
  close(clientDrainMilliseconds).pipe(
    Effect.timeoutOption(clientDrainMilliseconds),
    Effect.ignoreCause,
    Effect.asVoid
  );

const closeClient = (client: Sentry.BunClient): Effect.Effect<void> =>
  closeTelemetryClient((timeout) => Effect.promise(() => client.close(timeout)));

/** Constructs and globally binds the single production client during early preload. */
export const makeSentryTelemetry = (config: SentryTelemetryConfig): SentryTelemetry => {
  const client = makeSentryClient({
    dsn: config.dsn,
    config,
    transport: makeNetworkTransport,
    bindCurrentClient: true,
  });
  return {
    client,
    resource: {
      adapter: telemetryAdapter(client, config, randomUnitInterval),
      close: closeClient(client),
    },
  };
};

/**
 * Constructs an isolated Sentry client whose only egress is exact serialized envelope bytes. No
 * default integration, request hook, global handler, automatic breadcrumb, or network transport runs.
 */
export const makeSentryRecordingClient = (
  options: Partial<RecordingSentryConfig> = {}
): RecordingClient => {
  const envelopes: Array<Uint8Array> = [];
  const config: RecordingSentryConfig = { ...defaultRecordingConfig, ...options };
  const client = makeRecordingSentryClient(envelopes, config);
  const adapter = telemetryAdapter(client, config, config.randomUnitInterval);
  const close = closeClient(client);

  return {
    client,
    resource: { adapter, close },
    adapter,
    serializedEnvelopes: Effect.map(
      Effect.promise(() => client.flush(clientDrainMilliseconds)),
      () => envelopes.map((envelope) => envelope.slice())
    ),
    clear: Effect.sync(() => {
      envelopes.length = 0;
    }),
    close,
  };
};
