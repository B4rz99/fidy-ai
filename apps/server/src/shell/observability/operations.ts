import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { dual } from "effect/Function";
import {
  type DeclaredOutcome,
  DisabledTelemetryResource,
  DurableTraceContext,
  type SpanDescriptor,
  type TelemetryAdapter,
  TelemetryAttempt,
  type TelemetryCode,
  TelemetryCodeSchema,
  type TelemetryResource,
  type TelemetryService,
  TelemetrySpan,
  TelemetryStrictDecoding as strictDecoding,
} from "./contract";

export { DisabledTelemetryResource } from "./contract";
export type { TelemetryAdapter, TelemetryService, TelemetrySpan } from "./contract";

export {
  projectExternalHttpOutcome,
  projectExternalHttpRequest,
  projectExternalHttpResponse,
  projectStack,
} from "./contract";

/** The shell-owned metadata-only observability seam. */
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()(
  "@fidy/server/shell/observability/operations/Telemetry"
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
  "@fidy/server/shell/observability/operations/CurrentTelemetrySpan",
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
    () => Effect.succeedNone
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
    () => Effect.succeedNone
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
    onNone: () => Effect.succeedNone,
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
        observeWith({
          adapter,
          activeSpans,
          parent: Option.none(),
          descriptor,
          work,
        }),
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

/** Side-effect-free telemetry service for narrow optional-observability boundaries. */
export const DisabledTelemetry: TelemetryService = makeTelemetryService(
  DisabledTelemetryResource.adapter
);

/** Makes every telemetry operation a side-effect-free no-op while preserving wrapped Work. */
export const TelemetryDisabled: Layer.Layer<Telemetry> = Telemetry.layer(
  Effect.succeed(DisabledTelemetryResource)
);

const ExpectedFailure = Schema.Struct({
  error: Schema.Struct({ code: TelemetryCodeSchema.error }),
});

/** Reads the declared error contract out of one canonical failure, ignoring undeclared shapes. */
export const expectedOutcome = (failure: unknown): Option.Option<DeclaredOutcome> =>
  Option.map(Schema.decodeUnknownOption(ExpectedFailure)(failure), ({ error }) => ({
    outcome: "rejected",
    error: Option.some(error.code),
    retryable: false,
  }));

/**
 * The canonical operation span shared by HTTP-dispatched and hosted in-process execution, so both
 * paths remain observable through the same descriptor.
 */
export const operationDescriptor = (operation: TelemetryCode<"operation">): SpanDescriptor => ({
  component: "api",
  operation,
  trigger: "api",
  spanOperation: "fidy.operation",
  workKind: "canonical_operation",
  metadata: { _tag: "None" },
});

/** Records a declared canonical rejection as an outcome rather than an unexpected failure. */
export const recordExpectedOutcome =
  (telemetry: TelemetryService) =>
  (failure: unknown): Effect.Effect<void> =>
    Option.match(expectedOutcome(failure), {
      onNone: () => Effect.void,
      onSome: telemetry.recordOutcome,
    });

/** A checked-in schedule identity and its fixed exhausted-failure classification. */
export type ScheduledWorkDescriptor = Readonly<{
  component: TelemetryCode<"component">;
  schedule: Extract<TelemetryCode<"operation">, `task.${string}`>;
  operationalError: TelemetryCode<"error">;
}>;

const recordScheduledWorkExit = (
  telemetry: TelemetryService,
  descriptor: ScheduledWorkDescriptor,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.void;
  const cause = exit.cause;
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
    return telemetry.recordOutcome({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  if (Cause.hasDies(cause)) {
    return Effect.all(
      [
        telemetry.recordOutcome({
          outcome: "failed",
          error: Option.some("unexpected_defect"),
          retryable: false,
        }),
        telemetry.captureFailure({
          _tag: "Defect",
          component: descriptor.component,
          operation: descriptor.schedule,
          error: "unexpected_defect",
          cause,
        }),
      ],
      { discard: true }
    );
  }
  return Effect.all(
    [
      telemetry.recordOutcome({
        outcome: "failed",
        error: Option.some(descriptor.operationalError),
        retryable: true,
      }),
      telemetry.captureFailure({
        _tag: "ExhaustedOperationalFailure",
        component: descriptor.component,
        operation: descriptor.schedule,
        error: descriptor.operationalError,
        provider: Option.none(),
        retryable: true,
        cause,
      }),
    ],
    { discard: true }
  );
};

const observeScheduledWork = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  descriptor: ScheduledWorkDescriptor
): Effect.Effect<A, E, R | Telemetry> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.rootSpan(
      {
        component: descriptor.component,
        operation: descriptor.schedule,
        trigger: "schedule",
        spanOperation: "task.scheduled",
        workKind: "scheduled_execution",
        metadata: { _tag: "Schedule", attempt: TelemetryAttempt.make(1) },
      },
      Effect.onExit(work, (exit) => recordScheduledWorkExit(telemetry, descriptor, exit))
    );
  });

/**
 * Observes one independently triggered execution as an isolated root. The wrapped exit is unchanged;
 * expected outcomes may be declared by the work, pure shutdown interruption is not captured, and an
 * exhausted failure is captured once with only the descriptor's fixed diagnostic codes.
 */
export const runScheduledWork: {
  (
    descriptor: ScheduledWorkDescriptor
  ): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Telemetry>;
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    descriptor: ScheduledWorkDescriptor
  ): Effect.Effect<A, E, R | Telemetry>;
} = dual(2, observeScheduledWork);
