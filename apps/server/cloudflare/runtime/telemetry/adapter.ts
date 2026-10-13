import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import {
  DeclaredOutcome,
  type ProjectedTraceData,
  SpanDescriptor,
  type TelemetryAdapter,
  TelemetryBreadcrumb,
  TelemetryHttpStatus,
  TelemetryModelUsage,
  type TelemetryRelease,
  type TelemetrySpan,
  TelemetrySpanId,
  TelemetryStrictDecoding,
  TelemetryTraceId,
  type TelemetryWorkRecord,
  boundedTelemetryDuration,
} from "../../../src/shell/observability/contract";
import { projectHttpStatusClass } from "../../../src/shell/observability/operations";
import { WorkerTelemetryEvent } from "./contract";

type ActiveSpan = {
  descriptor: SpanDescriptor;
  release: TelemetryRelease;
  parentSpanId: Option.Option<typeof TelemetrySpanId.Type>;
  startedAt: number;
  outcome: Option.Option<DeclaredOutcome>;
  status: Option.Option<TelemetryHttpStatus>;
  usage: Option.Option<TelemetryModelUsage>;
  breadcrumbs: Array<TelemetryBreadcrumb>;
};

const maximumBreadcrumbs = 16;
const maximumActiveSpans = 1024;
const hexRadix = 16;
const spanIdBytes = 8;
const traceIdBytes = 16;
const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(hexRadix).padStart(2, "0")
  ).join("");

const spanStatus = (state: ActiveSpan): Option.Option<TelemetryHttpStatus> =>
  Option.orElse(state.status, () => {
    const value = state.descriptor.metadata;
    return value._tag === "Http" || value._tag === "Provider" ? value.status : Option.none();
  });

const modelRoundMetadata = (
  state: ActiveSpan,
  usage: Partial<ProjectedTraceData>
): Partial<ProjectedTraceData> =>
  state.descriptor.workKind === "model_round"
    ? { "gen_ai.request.model": "hosted_inference", ...usage }
    : {};

const metadata = (state: ActiveSpan): Partial<ProjectedTraceData> => {
  const value = state.descriptor.metadata;
  const status = spanStatus(state);
  const http = Option.match(status, {
    onNone: () => ({}),
    onSome: (code) => ({
      "http.response.status_code": code,
      "http.response.status_class": projectHttpStatusClass(code),
    }),
  });
  const usage = Option.match(state.usage, {
    onNone: () => ({}),
    onSome: (record) => ({
      "fidy.attempt": record.attempt,
      "gen_ai.usage.input_tokens": record.inputTokens,
      "gen_ai.usage.output_tokens": record.outputTokens,
    }),
  });
  switch (value._tag) {
    case "None":
      return modelRoundMetadata(state, usage);
    case "Http":
      return { ...http, "http.request.method": value.method, "http.route": value.route };
    case "Database":
      return {
        "db.system.name": value.system,
        "fidy.repository_operation": value.repositoryOperation,
      };
    case "Queue":
      return {
        "fidy.attempt": value.attempt,
        "fidy.input_count": value.inputCount,
        ...Option.match(value.delayMilliseconds, {
          onNone: () => ({}),
          onSome: (delay) => ({ "fidy.delay_milliseconds": delay }),
        }),
      };
    case "Provider":
      return { ...http, "fidy.provider": value.provider, "fidy.attempt": value.attempt };
    case "Model":
      return {
        "gen_ai.request.model": value.model,
        ...usage,
      };
    case "Schedule":
      return { "fidy.attempt": value.attempt };
  }
};

const isPureInterruption = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause);
const declaredFailure = (state: ActiveSpan): Option.Option<DeclaredOutcome> =>
  Option.filter(
    state.outcome,
    (outcome) => outcome.outcome === "failed" || outcome.outcome === "rejected"
  );

const terminalOutcome = (state: ActiveSpan, exit: Exit.Exit<unknown, unknown>): DeclaredOutcome => {
  if (Exit.isFailure(exit)) {
    if (isPureInterruption(exit.cause)) {
      return { outcome: "interrupted", error: Option.none(), retryable: false };
    }
    const declared = declaredFailure(state);
    if (!Cause.hasDies(exit.cause) && Option.isSome(declared)) return declared.value;
    return {
      outcome: "failed",
      error: Option.some(Cause.hasDies(exit.cause) ? "unexpected_defect" : "operational_failure"),
      retryable: false,
    };
  }
  return Option.getOrElse(state.outcome, () => ({
    outcome: "succeeded",
    error: Option.none(),
    retryable: false,
  }));
};

type ActiveSpans = Map<typeof TelemetrySpanId.Type, ActiveSpan>;
type EventSink = (event: WorkerTelemetryEvent) => void;

const startSpan =
  (active: ActiveSpans): TelemetryAdapter["startSpan"] =>
  (descriptor, parent) =>
    Effect.gen(function* () {
      if (active.size >= maximumActiveSpans) return Option.none();
      const decoded = yield* Schema.decodeEffect(
        SpanDescriptor,
        TelemetryStrictDecoding
      )(descriptor).pipe(Effect.orDie);
      const spanId = TelemetrySpanId.make(randomHex(spanIdBytes));
      const traceId = Option.match(parent, {
        onNone: () => TelemetryTraceId.make(randomHex(traceIdBytes)),
        onSome: (value) => value.traceId,
      });
      active.set(spanId, {
        descriptor: decoded,
        release:
          decoded.release ??
          Option.match(parent, {
            onNone: () => "unknown" as const,
            onSome: (value) => active.get(value.parentSpanId)?.release ?? "unknown",
          }),
        parentSpanId: Option.map(parent, (value) => value.parentSpanId),
        startedAt: yield* Clock.currentTimeMillis,
        outcome: Option.none(),
        status: Option.none(),
        usage: Option.none(),
        breadcrumbs: [],
      });
      return Option.some({
        traceId,
        spanId,
        sampled: Option.match(parent, { onNone: () => true, onSome: (value) => value.sampled }),
        state: undefined,
      });
    });

const finishSpan =
  (active: ActiveSpans, emit: EventSink): TelemetryAdapter["finishSpan"] =>
  (span, exit) =>
    Effect.gen(function* () {
      const state = active.get(span.spanId);
      active.delete(span.spanId);
      if (state === undefined || !span.sampled) return;
      const finishedAt = yield* Clock.currentTimeMillis;
      const outcome = terminalOutcome(state, exit);
      emit({
        event: "span",
        release: state.release,
        traceId: span.traceId,
        spanId: span.spanId,
        ...Option.match(state.parentSpanId, {
          onNone: () => ({}),
          onSome: (parentSpanId) => ({ parentSpanId }),
        }),
        spanOperation: state.descriptor.spanOperation,
        data: {
          ...metadata(state),
          "fidy.component": state.descriptor.component,
          "fidy.operation": state.descriptor.operation,
          "fidy.trigger": state.descriptor.trigger,
          "fidy.work_kind": state.descriptor.workKind,
          "fidy.outcome": outcome.outcome,
          "fidy.retryable": outcome.retryable,
        },
        ...Option.match(outcome.error, { onNone: () => ({}), onSome: (error) => ({ error }) }),
        latencyMilliseconds: boundedTelemetryDuration(finishedAt - state.startedAt),
        breadcrumbs: state.breadcrumbs,
      });
    });

const captureFailure =
  (active: ActiveSpans, emit: EventSink): TelemetryAdapter["captureFailure"] =>
  (span, failure) =>
    Effect.sync(() =>
      emit({
        event: "failure",
        release: Option.match(span, {
          onNone: () => "unknown" as const,
          onSome: (value) => active.get(value.spanId)?.release ?? "unknown",
        }),
        component: failure.component,
        operation: failure.operation,
        error: failure.error,
        classification: failure._tag,
        retryable: failure._tag === "ExhaustedOperationalFailure" && failure.retryable,
        ...Option.match(span, {
          onNone: () => ({}),
          onSome: (value) => ({ traceId: value.traceId, spanId: value.spanId }),
        }),
        ...(failure._tag === "ExhaustedOperationalFailure"
          ? Option.match(failure.provider, {
              onNone: () => ({}),
              onSome: (provider) => ({ provider }),
            })
          : {}),
      })
    );

const spanUpdates = (
  active: ActiveSpans
): Pick<
  TelemetryAdapter,
  "recordOutcome" | "recordResponseStatus" | "recordModelUsage" | "addBreadcrumb"
> => {
  const update = (span: TelemetrySpan, change: (state: ActiveSpan) => void): Effect.Effect<void> =>
    Effect.sync(() => {
      const state = active.get(span.spanId);
      if (state !== undefined) change(state);
    });
  return {
    recordOutcome: (span, value) =>
      update(span, (state) => {
        state.outcome = Option.some(
          Schema.decodeSync(DeclaredOutcome, TelemetryStrictDecoding)(value)
        );
      }),
    recordResponseStatus: (span, status) =>
      update(span, (state) => {
        if (
          state.descriptor.metadata._tag === "Http" ||
          state.descriptor.metadata._tag === "Provider"
        ) {
          state.status = Option.some(TelemetryHttpStatus.make(status));
        }
      }),
    recordModelUsage: (span, value) =>
      update(span, (state) => {
        if (
          state.descriptor.metadata._tag === "Model" ||
          state.descriptor.workKind === "model_round"
        ) {
          state.usage = Option.some(
            Schema.decodeSync(TelemetryModelUsage, TelemetryStrictDecoding)(value)
          );
        }
      }),
    addBreadcrumb: (span, value) =>
      update(span, (state) => {
        const breadcrumb = Schema.decodeSync(TelemetryBreadcrumb, TelemetryStrictDecoding)(value);
        if (state.breadcrumbs.length === maximumBreadcrumbs) state.breadcrumbs.shift();
        state.breadcrumbs.push(breadcrumb);
      }),
  };
};

/** Creates bounded synchronous native telemetry; accepted events need no later flush or persistence. */
export const makeWorkerTelemetryAdapter = (
  sink: Readonly<{ exportWork: (record: TelemetryWorkRecord) => void; exportEvent: EventSink }>
): TelemetryAdapter => {
  const active: ActiveSpans = new Map();
  const emit: EventSink = (event) =>
    sink.exportEvent(Schema.decodeSync(WorkerTelemetryEvent, TelemetryStrictDecoding)(event));
  return {
    startSpan: startSpan(active),
    finishSpan: finishSpan(active, emit),
    captureFailure: captureFailure(active, emit),
    ...spanUpdates(active),
    exportWork: sink.exportWork,
  };
};
