import { Clock, Context, Duration, Effect, type Exit, Layer, Option, Schema } from "effect";
import { strictDecoding } from "./decoding";
import {
  type ClassifiedFailure,
  type DeclaredOutcome,
  DurableTraceContext,
  type SpanDescriptor,
  type TelemetryBreadcrumb,
  type TelemetryHttpStatus,
  type TelemetryModelUsage,
} from "./protocol";

/** Opaque adapter-owned state plus the only validated trace coordinates the service may read. */
export const TelemetrySpan = Schema.Struct({
  traceId: DurableTraceContext.fields.traceId,
  spanId: DurableTraceContext.fields.parentSpanId,
  sampled: Schema.Boolean,
  state: Schema.Unknown,
});
export type TelemetrySpan = typeof TelemetrySpan.Type;

/**
 * Best-effort adapter contract used to construct a Telemetry layer. Implementations may perform side
 * effects, but the service validates returned spans and contains synchronous throws and failed Effects.
 */
export type TelemetryAdapter = {
  /** Allocates adapter state for a root or child; none means the caller's work runs unobserved. */
  readonly startSpan: (
    descriptor: SpanDescriptor,
    parent: Option.Option<DurableTraceContext>
  ) => Effect.Effect<Option.Option<TelemetrySpan>>;
  /** Completes a span exactly once after its wrapped work exits, using that unchanged Exit. */
  readonly finishSpan: (
    span: TelemetrySpan,
    exit: Exit.Exit<unknown, unknown>
  ) => Effect.Effect<void>;
  /** Replaces the declared outcome retained by an active adapter span. */
  readonly recordOutcome: (span: TelemetrySpan, outcome: DeclaredOutcome) => Effect.Effect<void>;
  /** Adds a validated HTTP response status to an active HTTP or provider span. */
  readonly recordResponseStatus: (
    span: TelemetrySpan,
    status: TelemetryHttpStatus
  ) => Effect.Effect<void>;
  /** Emits one already-classified failure, optionally attached to the supplied active span. */
  readonly captureFailure: (
    span: Option.Option<TelemetrySpan>,
    failure: ClassifiedFailure
  ) => Effect.Effect<void>;
  /** Retains one approved breadcrumb on the supplied active span. */
  readonly addBreadcrumb: (
    span: TelemetrySpan,
    breadcrumb: TelemetryBreadcrumb
  ) => Effect.Effect<void>;
  /** Retains final bounded usage on an active approved model span. */
  readonly recordModelUsage: (
    span: TelemetrySpan,
    usage: TelemetryModelUsage
  ) => Effect.Effect<void>;
};

/**
 * The sole application-facing observability capability. Methods accept closed diagnostic values,
 * are best effort, and span wrappers preserve the wrapped Effect's success, error, and requirements.
 */
export type TelemetryService = {
  /** Starts a root or child span; adapter failure runs work unobserved and never changes its exit. */
  readonly span: <A, E, R>(
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Starts an isolated root even when the calling fiber is already inside unrelated observed work. */
  readonly rootSpan: <A, E, R>(
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Continues context no older than 24 hours; malformed, future, or stale input starts a safe root. */
  readonly continueSpan: <A, E, R>(
    savedContext: unknown,
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Replaces the active span's declared outcome; the latest declaration wins. Outside a span, no-op. */
  readonly recordOutcome: (outcome: DeclaredOutcome) => Effect.Effect<void>;
  /** Adds a bounded response status to the active HTTP or provider span. Outside a span, no-op. */
  readonly recordResponseStatus: (status: TelemetryHttpStatus) => Effect.Effect<void>;
  /** Captures a classified failure, attaching active trace coordinates when a span exists. */
  readonly captureFailure: (failure: ClassifiedFailure) => Effect.Effect<void>;
  /** Adds an approved breadcrumb to the active span. Outside a span, no-op. */
  readonly addBreadcrumb: (breadcrumb: TelemetryBreadcrumb) => Effect.Effect<void>;
  /** Records final bounded counters on the active approved model span. Outside a span, no-op. */
  readonly recordModelUsage: (usage: TelemetryModelUsage) => Effect.Effect<void>;
  /** Returns only durable trace coordinates for the active span, or none outside a span. */
  readonly captureDurableContext: Effect.Effect<Option.Option<DurableTraceContext>>;
  /** Proves that coordinates name a currently active in-process span with the expected operation. */
  readonly isActiveSpan: (
    context: DurableTraceContext,
    operation: SpanDescriptor["operation"]
  ) => Effect.Effect<boolean>;
};

/** A telemetry adapter together with the shutdown effect that drains its accepted work. */
export type TelemetryResource = Readonly<{
  adapter: TelemetryAdapter;
  close: Effect.Effect<void>;
}>;

/** The shell-owned metadata-only observability seam. */
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()(
  "@fidy/server/shell/observability/telemetry"
) {
  /** Builds the service from a scoped adapter resource and drains it when the layer shuts down. */
  static readonly layer = <E, R>(
    resource: Effect.Effect<TelemetryResource, E, R>
  ): Layer.Layer<Telemetry, E, R> =>
    Layer.effect(
      Telemetry,
      Effect.acquireRelease(resource, (telemetryResource) => telemetryResource.close).pipe(
        Effect.map((telemetryResource) => makeTelemetryService(telemetryResource.adapter))
      )
    );
}

const CurrentTelemetrySpan = Context.Reference<Option.Option<TelemetrySpan>>(
  "@fidy/server/shell/observability/telemetry/CurrentTelemetrySpan",
  { defaultValue: Option.none }
);

const durableContextLifetimeHours = 24;
const durableContextLifetimeMilliseconds = Duration.toMillis(
  Duration.hours(durableContextLifetimeHours)
);

const ignoreTelemetryFailure = (effect: () => Effect.Effect<void>): Effect.Effect<void> =>
  Effect.ignoreCause(Effect.suspend(effect));

const startSafely = (
  adapter: TelemetryAdapter,
  descriptor: SpanDescriptor,
  parent: Option.Option<DurableTraceContext>
): Effect.Effect<Option.Option<TelemetrySpan>> =>
  Effect.catchCause(
    Effect.flatMap(
      Effect.suspend(() => adapter.startSpan(descriptor, parent)),
      (started) =>
        Effect.sync(() =>
          Option.flatMap(started, (span) =>
            Schema.decodeOption(TelemetrySpan, strictDecoding)(span)
          )
        )
    ),
    () => Effect.succeed(Option.none())
  );

const activeSpanKey = (traceId: string, spanId: string): string => `${traceId}:${spanId}`;

const observeWith = <A, E, R>(input: {
  readonly adapter: TelemetryAdapter;
  readonly activeSpans: Map<string, SpanDescriptor["operation"]>;
  readonly parent: Option.Option<DurableTraceContext>;
  readonly descriptor: SpanDescriptor;
  readonly work: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> =>
  Effect.flatMap(startSafely(input.adapter, input.descriptor, input.parent), (started) => {
    if (Option.isNone(started)) return input.work;
    const key = activeSpanKey(started.value.traceId, started.value.spanId);
    input.activeSpans.set(key, input.descriptor.operation);
    const observed = Effect.onExit(input.work, (exit) =>
      Effect.sync(() => input.activeSpans.delete(key)).pipe(
        Effect.andThen(ignoreTelemetryFailure(() => input.adapter.finishSpan(started.value, exit)))
      )
    );
    return Effect.provideService(observed, CurrentTelemetrySpan, started);
  });

const decodeFreshContext = (
  savedContext: unknown,
  now: number
): Effect.Effect<Option.Option<DurableTraceContext>> =>
  Effect.catchCause(
    Effect.sync(() =>
      Option.filter(
        Schema.decodeUnknownOption(DurableTraceContext, strictDecoding)(savedContext),
        (context) =>
          context.capturedAtUnixMilliseconds <= now &&
          now - context.capturedAtUnixMilliseconds <= durableContextLifetimeMilliseconds
      )
    ),
    () => Effect.succeed(Option.none())
  );

/**
 * The child-parent coordinates of an active span. `capturedAtUnixMilliseconds` is zero because a
 * same-fiber child never crosses a durable boundary and so is never age-checked.
 */
const inProcessParent = (active: TelemetrySpan): DurableTraceContext =>
  DurableTraceContext.make({
    version: 1,
    traceId: active.traceId,
    parentSpanId: active.spanId,
    sampled: active.sampled,
    capturedAtUnixMilliseconds: 0,
  });

/** Encodes approved durable coordinates as one W3C trace parent for loopback propagation. */
export const encodeTraceParent = (context: DurableTraceContext): string =>
  `00-${context.traceId}-${context.parentSpanId}-${context.sampled ? "01" : "00"}`;

/** Decodes only the strict W3C trace parent shape emitted by this service. */
export const decodeTraceParent = ({
  value,
  receivedAtUnixMilliseconds,
}: Readonly<{
  value: Option.Option<string>;
  receivedAtUnixMilliseconds: number;
}>): Option.Option<DurableTraceContext> => {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/u.exec(
    Option.getOrElse(value, () => "")
  );
  if (match === null) return Option.none();
  return Schema.decodeUnknownOption(DurableTraceContext)({
    version: 1,
    traceId: match[1],
    parentSpanId: match[2],
    sampled: match[3] === "01",
    capturedAtUnixMilliseconds: receivedAtUnixMilliseconds,
  });
};

const durableContextOf = (
  span: Option.Option<TelemetrySpan>
): Effect.Effect<Option.Option<DurableTraceContext>> =>
  Option.match(span, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (active) =>
      Effect.map(Clock.currentTimeMillis, (capturedAtUnixMilliseconds) =>
        Option.some(
          DurableTraceContext.make({
            version: 1,
            traceId: active.traceId,
            parentSpanId: active.spanId,
            sampled: active.sampled,
            capturedAtUnixMilliseconds,
          })
        )
      ),
  });

const withActiveSpan = (
  effect: (span: TelemetrySpan) => Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.flatMap(CurrentTelemetrySpan, (span) =>
    Option.match(span, {
      onNone: () => Effect.void,
      onSome: effect,
    })
  );

/** Constructs the public service around an adapter while containing every adapter defect. */
export const makeTelemetryService = (adapter: TelemetryAdapter): TelemetryService => {
  const activeSpans = new Map<string, SpanDescriptor["operation"]>();
  return Telemetry.of({
    span: (descriptor, work) =>
      Effect.flatMap(CurrentTelemetrySpan, (current) =>
        observeWith({
          adapter,
          activeSpans,
          parent: Option.map(current, inProcessParent),
          descriptor,
          work,
        })
      ),
    rootSpan: (descriptor, work) =>
      Effect.provideService(
        observeWith({ adapter, activeSpans, parent: Option.none(), descriptor, work }),
        CurrentTelemetrySpan,
        Option.none()
      ),
    continueSpan: (savedContext, descriptor, work) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.flatMap(decodeFreshContext(savedContext, now), (parent) =>
          observeWith({ adapter, activeSpans, parent, descriptor, work })
        )
      ),
    recordOutcome: (outcome) =>
      withActiveSpan((active) =>
        ignoreTelemetryFailure(() => adapter.recordOutcome(active, outcome))
      ),
    recordResponseStatus: (status) =>
      withActiveSpan((active) =>
        ignoreTelemetryFailure(() => adapter.recordResponseStatus(active, status))
      ),
    captureFailure: (failure) =>
      Effect.flatMap(CurrentTelemetrySpan, (span) =>
        ignoreTelemetryFailure(() => adapter.captureFailure(span, failure))
      ),
    addBreadcrumb: (breadcrumb) =>
      withActiveSpan((active) =>
        ignoreTelemetryFailure(() => adapter.addBreadcrumb(active, breadcrumb))
      ),
    recordModelUsage: (usage) =>
      withActiveSpan((active) =>
        ignoreTelemetryFailure(() => adapter.recordModelUsage(active, usage))
      ),
    captureDurableContext: Effect.flatMap(CurrentTelemetrySpan, durableContextOf),
    isActiveSpan: (context, operation) =>
      Effect.sync(
        () => activeSpans.get(activeSpanKey(context.traceId, context.parentSpanId)) === operation
      ),
  });
};
