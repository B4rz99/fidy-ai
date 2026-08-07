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
  projectTransaction,
} from "./projectors";
import {
  type ClassifiedFailure,
  DeclaredOutcome,
  type DurableTraceContext,
  SpanDescriptor,
  type TelemetryBreadcrumb,
  TelemetrySpanId,
  TelemetryTraceId,
} from "./protocol";
import type { TelemetryAdapter, TelemetrySpan } from "./telemetry";

const recordingDsn = "https://public@example.invalid/1";
const recordingRelease = "fidy-ai@0.0.0-test";
const recordingEnvironment = "test";
const hexRadix = 16;
const traceIdByteLength = 16;
const spanIdByteLength = 8;
const millisecondsPerSecond = 1_000;
/** Reported to the SDK for every recorded and every skipped envelope; nothing leaves the process. */
const acceptedStatusCode = 200;
/** Bounds the wait for the SDK's own queue when reading recorded bytes and when closing. */
const clientDrainMilliseconds = 1_000;

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

const safeErrorEvent = (event: Sentry.ErrorEvent): Option.Option<Sentry.ErrorEvent> => {
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
                filename: frame.filename,
                function: frame.function,
                lineno: frame.lineno,
                colno: frame.colno,
              })),
            },
          })),
        };
  const trace = event.contexts?.trace;
  const projected = Schema.decodeUnknownOption(
    ProjectedErrorEvent,
    strictDecoding
  )({
    timestamp: event.timestamp,
    level: "error",
    exception: selectedException,
    fingerprint: event.fingerprint,
    tags: event.tags,
    breadcrumbs: event.breadcrumbs ?? [],
    ...(trace === undefined
      ? {}
      : {
          contexts: {
            trace: {
              trace_id: trace.trace_id,
              span_id: trace.span_id,
              ...(trace.parent_span_id === undefined
                ? {}
                : { parent_span_id: trace.parent_span_id }),
              op: trace.op,
            },
          },
        }),
  });
  return Option.map(projected, (value) =>
    castSdkEvent<Sentry.ErrorEvent>({
      event_id: event.event_id,
      platform: "javascript",
      release: recordingRelease,
      environment: recordingEnvironment,
      ...value,
    })
  );
};

type TransactionEvent = Sentry.Event & Readonly<{ readonly type: "transaction" }>;

const safeTransactionEvent = (event: TransactionEvent): Option.Option<TransactionEvent> => {
  const projected = Schema.decodeUnknownOption(
    ProjectedTransaction,
    strictDecoding
  )({
    type: "transaction",
    transaction: event.transaction,
    transaction_info: { source: "custom" },
    start_timestamp: event.start_timestamp,
    timestamp: event.timestamp,
    contexts: { trace: event.contexts?.trace },
    tags: event.tags,
    breadcrumbs: event.breadcrumbs ?? [],
  });
  return Option.map(projected, (value) =>
    castSdkEvent<TransactionEvent>({
      event_id: event.event_id,
      platform: "javascript",
      release: recordingRelease,
      environment: recordingEnvironment,
      spans: [],
      ...value,
    })
  );
};

const randomHex = (bytes: number): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(hexRadix).padStart(2, "0")).join("");
};

type ActiveState = {
  readonly descriptor: unknown;
  readonly trace: Omit<ActiveTraceCoordinates, "spanOperation">;
  readonly startedAt: number;
  readonly breadcrumbs: Array<ProjectedBreadcrumb>;
  outcome: Option.Option<unknown>;
};

/** The private client state every adapter method needs: where events go, and which spans are live. */
type RecordingSink = Readonly<{
  readonly scope: Sentry.Scope;
  readonly knownStates: WeakMap<object, ActiveState>;
}>;

type RecordingClient = Readonly<{
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
  options: Parameters<typeof Sentry.createTransport>[0]
): ReturnType<typeof Sentry.createTransport> => {
  const base = Sentry.createTransport(options, (request) => {
    envelopes.push(copyBytes(request.body));
    return Promise.resolve({ statusCode: acceptedStatusCode });
  });
  return {
    send: (envelope: Parameters<typeof base.send>[0]): ReturnType<typeof base.send> =>
      isSupportedEnvelope(envelope)
        ? base.send(envelope)
        : Promise.resolve({ statusCode: acceptedStatusCode }),
    flush: (timeout?: number): ReturnType<typeof base.flush> => base.flush(timeout),
  };
};

/**
 * Every SDK feature that could widen an event is switched off here rather than filtered later: no
 * integration, no default PII, no attached stack, no retained SDK breadcrumb, and no default
 * transport. The two send hooks are the last boundary — each rebuilds its event from approved
 * fields alone and drops it outright on a projector defect, so nothing the SDK added survives.
 */
const makeRecordingSentryClient = (envelopes: Array<Uint8Array>): Sentry.BunClient => {
  const options: ConstructorParameters<typeof Sentry.BunClient>[0] = {
    dsn: recordingDsn,
    transport: (transportOptions) => makeRecordingTransport(envelopes, transportOptions),
    stackParser: Sentry.defaultStackParser,
    integrations: [],
    sampleRate: 1,
    tracesSampleRate: 1,
    sendDefaultPii: false,
    attachStacktrace: false,
    maxBreadcrumbs: 0,
    release: recordingRelease,
    environment: recordingEnvironment,
    beforeSend: (event) => {
      try {
        return Option.getOrNull(safeErrorEvent(event));
      } catch {
        return null;
      }
    },
    beforeSendTransaction: (event) => {
      try {
        return Option.getOrNull(safeTransactionEvent(event));
      } catch {
        return null;
      }
    },
    beforeBreadcrumb: () => null,
  };
  const client = new Sentry.BunClient(options);
  client.init();
  return client;
};

const startRecordedSpan = (
  sink: RecordingSink,
  descriptor: SpanDescriptor,
  parent: Option.Option<DurableTraceContext>
): Effect.Effect<Option.Option<TelemetrySpan>> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const decoded = Schema.decodeUnknownOption(SpanDescriptor, strictDecoding)(descriptor);
    if (Option.isNone(decoded)) return Option.none();
    const traceId = Option.match(parent, {
      onNone: () => TelemetryTraceId.make(randomHex(traceIdByteLength)),
      onSome: (context) => context.traceId,
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
      breadcrumbs: [],
      outcome: Option.none(),
    };
    sink.knownStates.set(state, state);
    return Option.some({ traceId, spanId, sampled: true, state });
  });

const finishRecordedSpan = (
  sink: RecordingSink,
  span: TelemetrySpan,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      const projected = projectTransaction({
        descriptor: state.descriptor,
        outcome: Option.getOrElse(state.outcome, () => exitOutcome(exit)),
        traceId: state.trace.traceId,
        spanId: state.trace.spanId,
        parentSpanId: state.trace.parentSpanId,
        startedAt: state.startedAt,
        finishedAt: now / millisecondsPerSecond,
        breadcrumbs: state.breadcrumbs,
      });
      if (Option.isSome(projected)) capture(sink.scope, projected.value);
    });
  });

const recordSpanOutcome = (
  sink: RecordingSink,
  span: TelemetrySpan,
  outcome: DeclaredOutcome
): Effect.Effect<void> =>
  Effect.sync(() => {
    Option.map(activeState(sink.knownStates, span), (state) => {
      state.outcome = Option.some(outcome);
    });
  });

const captureRecordedFailure = (
  sink: RecordingSink,
  span: Option.Option<TelemetrySpan>,
  failure: ClassifiedFailure
): Effect.Effect<void> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
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
      breadcrumbs: Option.match(state, {
        onNone: () => [],
        onSome: (current) => current.breadcrumbs,
      }),
    });
    if (Option.isSome(projected)) capture(sink.scope, projected.value);
  });

const addRecordedBreadcrumb = (
  sink: RecordingSink,
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

/**
 * Constructs an isolated Sentry client whose only egress is exact serialized envelope bytes. No
 * default integration, request hook, global handler, automatic breadcrumb, or network transport runs.
 */
export const makeSentryRecordingClient = (): RecordingClient => {
  const envelopes: Array<Uint8Array> = [];
  const client = makeRecordingSentryClient(envelopes);
  const scope = new Sentry.Scope();
  scope.setClient(client);
  const sink: RecordingSink = { scope, knownStates: new WeakMap() };
  const adapter: TelemetryAdapter = {
    startSpan: (descriptor, parent) => startRecordedSpan(sink, descriptor, parent),
    finishSpan: (span, exit) => finishRecordedSpan(sink, span, exit),
    recordOutcome: (span, outcome) => recordSpanOutcome(sink, span, outcome),
    captureFailure: (span, failure) => captureRecordedFailure(sink, span, failure),
    addBreadcrumb: (span, breadcrumb) => addRecordedBreadcrumb(sink, span, breadcrumb),
  };

  return {
    adapter,
    serializedEnvelopes: Effect.map(
      Effect.promise(() => client.flush(clientDrainMilliseconds)),
      () => envelopes.map((envelope) => envelope.slice())
    ),
    clear: Effect.sync(() => {
      envelopes.length = 0;
    }),
    close: Effect.asVoid(Effect.promise(() => client.close(clientDrainMilliseconds))),
  };
};
