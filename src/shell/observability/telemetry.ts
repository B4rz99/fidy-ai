import { Clock, Context, Duration, Effect, type Exit, Layer, Option, Schema } from "effect";
import { strictDecoding } from "./decoding";
import {
  type ClassifiedFailure,
  type DeclaredOutcome,
  DurableTraceContext,
  type SpanDescriptor,
  type TelemetryBreadcrumb,
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
  /** Continues context no older than 24 hours; malformed, future, or stale input starts a safe root. */
  readonly continueSpan: <A, E, R>(
    savedContext: unknown,
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** Replaces the active span's declared outcome; the latest declaration wins. Outside a span, no-op. */
  readonly recordOutcome: (outcome: DeclaredOutcome) => Effect.Effect<void>;
  /** Captures a classified failure, attaching active trace coordinates when a span exists. */
  readonly captureFailure: (failure: ClassifiedFailure) => Effect.Effect<void>;
  /** Adds an approved breadcrumb to the active span. Outside a span, no-op. */
  readonly addBreadcrumb: (breadcrumb: TelemetryBreadcrumb) => Effect.Effect<void>;
  /** Returns only durable trace coordinates for the active span, or none outside a span. */
  readonly captureDurableContext: Effect.Effect<Option.Option<DurableTraceContext>>;
};

/** The shell-owned metadata-only observability seam. */
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()(
  "fidy-ai/shell/observability/telemetry"
) {}

const CurrentTelemetrySpan = Context.Reference<Option.Option<TelemetrySpan>>(
  "fidy-ai/shell/observability/telemetry/CurrentTelemetrySpan",
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
            Schema.decodeUnknownOption(TelemetrySpan, strictDecoding)(span)
          )
        )
    ),
    () => Effect.succeed(Option.none())
  );

const observeWith = <A, E, R>(input: {
  readonly adapter: TelemetryAdapter;
  readonly parent: Option.Option<DurableTraceContext>;
  readonly descriptor: SpanDescriptor;
  readonly work: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> =>
  Effect.flatMap(startSafely(input.adapter, input.descriptor, input.parent), (started) => {
    if (Option.isNone(started)) return input.work;
    const observed = Effect.onExit(input.work, (exit) =>
      ignoreTelemetryFailure(() => input.adapter.finishSpan(started.value, exit))
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

/** Constructs the public service around an adapter while containing every adapter defect. */
export const makeTelemetryService = (adapter: TelemetryAdapter): TelemetryService =>
  Telemetry.of({
    span: (descriptor, work) =>
      Effect.flatMap(CurrentTelemetrySpan, (current) =>
        observeWith({
          adapter,
          parent: Option.map(current, inProcessParent),
          descriptor,
          work,
        })
      ),
    continueSpan: (savedContext, descriptor, work) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.flatMap(decodeFreshContext(savedContext, now), (parent) =>
          observeWith({ adapter, parent, descriptor, work })
        )
      ),
    recordOutcome: (outcome) =>
      Effect.flatMap(CurrentTelemetrySpan, (span) =>
        Option.match(span, {
          onNone: () => Effect.void,
          onSome: (active) => ignoreTelemetryFailure(() => adapter.recordOutcome(active, outcome)),
        })
      ),
    captureFailure: (failure) =>
      Effect.flatMap(CurrentTelemetrySpan, (span) =>
        ignoreTelemetryFailure(() => adapter.captureFailure(span, failure))
      ),
    addBreadcrumb: (breadcrumb) =>
      Effect.flatMap(CurrentTelemetrySpan, (span) =>
        Option.match(span, {
          onNone: () => Effect.void,
          onSome: (active) =>
            ignoreTelemetryFailure(() => adapter.addBreadcrumb(active, breadcrumb)),
        })
      ),
    captureDurableContext: Effect.flatMap(CurrentTelemetrySpan, durableContextOf),
  });

/** Provides a constructed adapter as the application's single Telemetry capability. */
export const telemetryLayer = (adapter: TelemetryAdapter): Layer.Layer<Telemetry> =>
  Layer.succeed(Telemetry, makeTelemetryService(adapter));
