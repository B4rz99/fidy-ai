/**
 * Projectors rebuild an untrusted value into the exact shape allowed past the Sentry boundary,
 * constructing each field from a closed schema rather than removing fields from the original.
 */
import { Option, Predicate, Schema } from "effect";
import {
  ClassifiedFailure,
  DeclaredOutcome,
  type DurableTraceContext,
  ProjectedBreadcrumb,
  type ProjectedErrorEvent,
  ProjectedFinalSpan,
  type ProjectedTrace,
  ProjectedTraceData,
  type ProjectedTransaction,
  SpanDescriptor,
  TelemetryBreadcrumb,
  type TelemetryCode,
  TelemetryDuration,
  TelemetryModelUsage,
  projectHttpStatusClass,
  projectStack,
  TelemetryStrictDecoding as strictDecoding,
} from "~/shell/observability/contract";

const decodeStrict = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  value: unknown
): Option.Option<Decoded> => Schema.decodeUnknownOption(schema, strictDecoding)(value);

/** Reconstructs a final SDK breadcrumb exclusively from the already-approved breadcrumb schema. */
export const projectFinalBreadcrumb = (value: unknown): Option.Option<ProjectedBreadcrumb> =>
  Option.map(decodeStrict(ProjectedBreadcrumb, value), (breadcrumb) => ({
    category: breadcrumb.category,
    message: breadcrumb.message,
    level: "info",
    timestamp: breadcrumb.timestamp,
    data: { ...breadcrumb.data },
  }));

/** Strictly reconstructs one approved breadcrumb; malformed or widened input returns none. */
export const projectBreadcrumb = (input: {
  readonly breadcrumb: unknown;
  /** Unix timestamp in seconds supplied by the adapter clock. */
  readonly timestamp: number;
}): Option.Option<ProjectedBreadcrumb> =>
  Option.map(decodeStrict(TelemetryBreadcrumb, input.breadcrumb), (breadcrumb) => ({
    category: breadcrumb.category,
    message: breadcrumb.action,
    level: "info" as const,
    timestamp: input.timestamp,
    data: {
      component: breadcrumb.component,
      ...Option.match(breadcrumb.outcome, {
        onNone: () => ({}),
        onSome: (outcome) => ({ outcome }),
      }),
      ...Option.match(breadcrumb.error, {
        onNone: () => ({}),
        onSome: (error) => ({ error }),
      }),
      ...Option.match(breadcrumb.attempt, {
        onNone: () => ({}),
        onSome: (attempt) => ({ attempt }),
      }),
      ...Option.match(breadcrumb.durationMilliseconds, {
        onNone: () => ({}),
        onSome: (duration_milliseconds) => ({ duration_milliseconds }),
      }),
    },
  }));

const maximumTelemetryDurationMilliseconds = 86_400_000;
const millisecondsPerSecond = 1_000;
const durationWorkKinds = new Set<SpanDescriptor["workKind"]>([
  "http_request",
  "provider_call",
  "scheduled_execution",
  "model_call",
]);

const elapsedDurationAttributes = (input: {
  readonly workKind: SpanDescriptor["workKind"];
  readonly startedAt: number;
  readonly finishedAt: number;
}): Readonly<Record<string, TelemetryDuration>> =>
  durationWorkKinds.has(input.workKind)
    ? {
        "fidy.duration_milliseconds": TelemetryDuration.make(
          Math.min(
            maximumTelemetryDurationMilliseconds,
            Math.max(0, Math.round((input.finishedAt - input.startedAt) * millisecondsPerSecond))
          )
        ),
      }
    : {};

const spanAttributes = (
  metadata: SpanDescriptor["metadata"],
  modelUsage: Option.Option<TelemetryModelUsage>
): Readonly<Record<string, string | number | boolean>> => {
  switch (metadata._tag) {
    case "None":
      return {};
    case "Http":
      return {
        "http.request.method": metadata.method,
        "http.route": metadata.route,
        ...Option.match(metadata.status, {
          onNone: () => ({}),
          onSome: (value) => ({ "http.response.status_code": value }),
        }),
      };
    case "Database":
      return {
        "db.system.name": metadata.system,
        "fidy.repository_operation": metadata.repositoryOperation,
      };
    case "Queue":
      return {
        "fidy.attempt": metadata.attempt,
        "fidy.input_count": metadata.inputCount,
        ...Option.match(metadata.delayMilliseconds, {
          onNone: () => ({}),
          onSome: (value) => ({ "fidy.delay_milliseconds": value }),
        }),
      };
    case "Provider":
      return {
        "fidy.provider": metadata.provider,
        "fidy.attempt": metadata.attempt,
        ...Option.match(metadata.status, {
          onNone: () => ({}),
          onSome: (value) => ({
            "http.response.status_code": value,
            "http.response.status_class": projectHttpStatusClass(value),
          }),
        }),
      };
    case "Model":
      return {
        "gen_ai.request.model": metadata.model,
        ...Option.match(modelUsage, {
          onNone: () => ({}),
          onSome: (usage) => ({
            "fidy.attempt": usage.attempt,
            "gen_ai.usage.input_tokens": usage.inputTokens,
            "gen_ai.usage.output_tokens": usage.outputTokens,
          }),
        }),
      };
    case "Schedule":
      return { "fidy.attempt": metadata.attempt };
  }
};

const getUnknownProperty = (value: object, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

const pickPresent = (
  value: object,
  keys: ReadonlyArray<string>
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    keys.flatMap<readonly [string, unknown]>((key) => {
      const candidate = getUnknownProperty(value, key);
      return candidate === undefined ? [] : [[key, candidate] as const];
    })
  );

const projectFinalSpanData = (value: unknown): unknown =>
  Predicate.isObject(value)
    ? pickPresent(value, Object.keys(ProjectedTraceData.fields))
    : undefined;

/** Reconstructs a final SDK span and drops profile, measurement, link, origin, and widened data. */
export const projectFinalSpan = (value: unknown): Option.Option<ProjectedFinalSpan> => {
  if (!Predicate.isObject(value)) return Option.none();
  return decodeStrict(ProjectedFinalSpan, {
    ...pickPresent(
      value,
      Object.keys(ProjectedFinalSpan.fields).filter((key) => key !== "data")
    ),
    data: projectFinalSpanData(getUnknownProperty(value, "data")),
  });
};

const transactionName = (descriptor: SpanDescriptor): string =>
  descriptor.metadata._tag === "Http"
    ? `${descriptor.metadata.method} ${descriptor.metadata.route}`
    : descriptor.operation;

const outcomeStatus = (outcome: DeclaredOutcome["outcome"]): ProjectedTrace["status"] => {
  switch (outcome) {
    case "succeeded":
      return "ok";
    case "rejected":
      return "invalid_argument";
    case "failed":
      return "internal_error";
    case "interrupted":
      return "cancelled";
  }
};

const transactionData = ({
  descriptor,
  outcome,
  modelUsage,
  startedAt,
  finishedAt,
}: Readonly<{
  descriptor: SpanDescriptor;
  outcome: DeclaredOutcome;
  modelUsage: Option.Option<TelemetryModelUsage>;
  startedAt: number;
  finishedAt: number;
}>): ProjectedTrace["data"] => ({
  "fidy.component": descriptor.component,
  "fidy.operation": descriptor.operation,
  "fidy.trigger": descriptor.trigger,
  "fidy.work_kind": descriptor.workKind,
  "fidy.outcome": outcome.outcome,
  "fidy.retryable": outcome.retryable,
  ...elapsedDurationAttributes({
    workKind: descriptor.workKind,
    startedAt,
    finishedAt,
  }),
  ...spanAttributes(descriptor.metadata, modelUsage),
});

/** Strictly reconstructs the transaction event for one completed bounded span. */
export const projectTransaction = (input: {
  readonly descriptor: unknown;
  readonly outcome: unknown;
  readonly traceId: DurableTraceContext["traceId"];
  readonly spanId: DurableTraceContext["parentSpanId"];
  readonly parentSpanId: Option.Option<DurableTraceContext["parentSpanId"]>;
  /** Span start as a Unix timestamp in seconds. */
  readonly startedAt: number;
  /** Span completion as a Unix timestamp in seconds. */
  readonly finishedAt: number;
  readonly breadcrumbs: ReadonlyArray<ProjectedBreadcrumb>;
  readonly modelUsage: Option.Option<unknown>;
}): Option.Option<ProjectedTransaction> =>
  Option.flatMap(decodeStrict(SpanDescriptor, input.descriptor), (descriptor) =>
    Option.map(decodeStrict(DeclaredOutcome, input.outcome), (outcome) => {
      const modelUsage = Option.flatMap(input.modelUsage, (usage) =>
        decodeStrict(TelemetryModelUsage, usage)
      );
      return {
        type: "transaction" as const,
        transaction: transactionName(descriptor),
        transaction_info: { source: "custom" as const },
        start_timestamp: input.startedAt,
        timestamp: input.finishedAt,
        contexts: {
          trace: {
            trace_id: input.traceId,
            span_id: input.spanId,
            ...Option.match(input.parentSpanId, {
              onNone: () => ({}),
              onSome: (parent_span_id) => ({ parent_span_id }),
            }),
            op: descriptor.spanOperation,
            status: outcomeStatus(outcome.outcome),
            data: transactionData({
              descriptor,
              outcome,
              modelUsage,
              startedAt: input.startedAt,
              finishedAt: input.finishedAt,
            }),
          },
        },
        tags: {
          component: descriptor.component,
          operation: descriptor.operation,
          trigger: descriptor.trigger,
          work_kind: descriptor.workKind,
          outcome: outcome.outcome,
          retryable: outcome.retryable ? "true" : "false",
          ...Option.match(outcome.error, {
            onNone: () => ({}),
            onSome: (error) => ({ error }),
          }),
        },
        breadcrumbs: input.breadcrumbs,
      };
    })
  );

/** Active coordinates required to attach a classified error to its transaction. */
export type ActiveTraceCoordinates = Readonly<{
  readonly traceId: DurableTraceContext["traceId"];
  readonly spanId: DurableTraceContext["parentSpanId"];
  readonly parentSpanId: Option.Option<DurableTraceContext["parentSpanId"]>;
  readonly spanOperation: TelemetryCode<"spanOperation">;
}>;

/** Strictly reconstructs one classified error event; cause contributes stack coordinates only. */
export const projectErrorEvent = (input: {
  readonly failure: unknown;
  /** Unix timestamp in seconds supplied by the adapter clock. */
  readonly timestamp: number;
  readonly activeTrace: Option.Option<ActiveTraceCoordinates>;
}): Option.Option<ProjectedErrorEvent> =>
  Option.map(decodeStrict(ClassifiedFailure, input.failure), (failure) => {
    const operational = failure._tag === "ExhaustedOperationalFailure";
    const retryable = operational ? failure.retryable : false;
    const providerCode = operational ? failure.provider : Option.none();
    return {
      timestamp: input.timestamp,
      level: "error" as const,
      exception: {
        values: [
          {
            type: operational ? ("FidyOperationalFailure" as const) : ("FidyDefect" as const),
            value: operational
              ? ("Exhausted operational failure" as const)
              : ("Unexpected defect" as const),
            stacktrace: { frames: projectStack(failure.cause) },
          },
        ],
      },
      fingerprint: [failure.component, failure.operation, failure.error],
      tags: {
        component: failure.component,
        operation: failure.operation,
        error: failure.error,
        retryable: retryable ? "true" : "false",
        ...Option.match(providerCode, {
          onNone: () => ({}),
          onSome: (provider) => ({ provider }),
        }),
      },
      ...Option.match(input.activeTrace, {
        onNone: () => ({}),
        onSome: (trace) => ({
          contexts: {
            trace: {
              trace_id: trace.traceId,
              span_id: trace.spanId,
              ...Option.match(trace.parentSpanId, {
                onNone: () => ({}),
                onSome: (parent_span_id) => ({ parent_span_id }),
              }),
              op: trace.spanOperation,
            },
          },
        }),
      }),
    };
  });
