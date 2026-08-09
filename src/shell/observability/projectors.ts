/**
 * Projectors rebuild an untrusted value into the exact shape allowed past the Sentry boundary,
 * constructing each field from a closed schema rather than removing fields from the original.
 */
import { Cause, Function as Fn, Option, Predicate, Schema } from "effect";
import { strictDecoding } from "./decoding";
import {
  ClassifiedFailure,
  DeclaredOutcome,
  type DurableTraceContext,
  SpanDescriptor,
  TelemetryAttempt,
  TelemetryBreadcrumb,
  TelemetryCount,
  TelemetryDuration,
  TelemetryHttpStatus,
  TelemetrySpanId,
  TelemetryTraceId,
} from "./protocol";
import { type TelemetryCode, TelemetryCodeSchema } from "./registry";

const decodeStrict = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  value: unknown
): Option.Option<Decoded> => Schema.decodeUnknownOption(schema, strictDecoding)(value);

const safeFunctionPattern = /^[A-Za-z_$][A-Za-z0-9_.$<>-]{0,119}$/u;
const safeSourceFilePattern = /^src\/[A-Za-z0-9_./-]{1,220}\.(?:ts|tsx|js|mjs)$/u;
const stackLinePattern = /^\s*at\s+(?:([^\s(]+)\s+\()?(.+):(\d+):(\d+)\)?\s*$/u;
const PositiveStackCoordinate = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
);

/** Closed stack coordinates that cannot carry exception messages, source context, URLs, or locals. */
export const ProjectedStackFrame = Schema.Struct({
  filename: Schema.String.check(Schema.isPattern(safeSourceFilePattern)),
  function: Schema.String.check(Schema.isPattern(safeFunctionPattern)),
  lineno: PositiveStackCoordinate,
  colno: PositiveStackCoordinate,
});
export type ProjectedStackFrame = typeof ProjectedStackFrame.Type;

/** The exact breadcrumb fields permitted to enter an SDK event. */
export const ProjectedBreadcrumb = Schema.Struct({
  category: TelemetryCodeSchema.breadcrumbCategory,
  message: TelemetryCodeSchema.breadcrumbAction,
  level: Schema.Literal("info"),
  timestamp: Schema.Finite,
  data: Schema.Struct({
    component: TelemetryCodeSchema.component,
    outcome: Schema.optionalKey(TelemetryCodeSchema.outcome),
    error: Schema.optionalKey(TelemetryCodeSchema.error),
    attempt: Schema.optionalKey(TelemetryAttempt),
    duration_milliseconds: Schema.optionalKey(TelemetryDuration),
  }),
});
export type ProjectedBreadcrumb = typeof ProjectedBreadcrumb.Type;

/** Reconstructs a final SDK breadcrumb exclusively from the already-approved breadcrumb schema. */
export const projectFinalBreadcrumb = (value: unknown): Option.Option<ProjectedBreadcrumb> =>
  Option.map(decodeStrict(ProjectedBreadcrumb, value), (breadcrumb) => ({
    category: breadcrumb.category,
    message: breadcrumb.message,
    level: "info",
    timestamp: breadcrumb.timestamp,
    data: { ...breadcrumb.data },
  }));

const ProjectedTraceCoordinates = {
  trace_id: TelemetryTraceId,
  span_id: TelemetrySpanId,
  parent_span_id: Schema.optionalKey(TelemetrySpanId),
  op: TelemetryCodeSchema.spanOperation,
} as const;

// A failure can be captured with no Span in scope, and the SDK then supplies trace coordinates that
// name no operation. Only the error shape may omit `op`: a transaction always originates in a Span.
const ProjectedErrorTraceCoordinates = {
  ...ProjectedTraceCoordinates,
  op: Schema.optionalKey(TelemetryCodeSchema.spanOperation),
} as const;

const normalizeSourceFile = (value: string): Option.Option<string> => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return Option.none();
  const sourceMarker = value.lastIndexOf("/src/");
  const relative = sourceMarker >= 0 ? value.slice(sourceMarker + 1) : value;
  if (relative.split("/").some((segment) => segment === "." || segment === "..")) {
    return Option.none();
  }
  return safeSourceFilePattern.test(relative) ? Option.some(relative) : Option.none();
};

/**
 * Reconstructs the coordinates of one native stack line. An unrecognized line, a file outside
 * `src/`, an unsafe function name, and a non-positive coordinate all yield none rather than a
 * partial frame; `ProjectedStackFrame` is the single authority on what survives.
 */
const projectStackLine = (line: string): Option.Option<ProjectedStackFrame> => {
  const match = stackLinePattern.exec(line);
  if (match === null) return Option.none();
  return Option.flatMap(normalizeSourceFile(match[2] ?? ""), (filename) =>
    decodeStrict(ProjectedStackFrame, {
      filename,
      function: match[1] ?? "anonymous",
      lineno: Number(match[3]),
      colno: Number(match[4]),
    })
  );
};

const projectReasonStack = (reason: Cause.Reason<unknown>): ReadonlyArray<ProjectedStackFrame> => {
  if (Cause.isFailReason(reason)) return projectStack(reason.error);
  if (Cause.isDieReason(reason)) return projectStack(reason.defect);
  return [];
};

/** Extracts only application source coordinates from an Error or every reason in an Effect Cause. */
export const projectStack = (cause: unknown): ReadonlyArray<ProjectedStackFrame> => {
  if (Cause.isCause(cause)) return cause.reasons.flatMap(projectReasonStack);
  if (!(cause instanceof Error) || typeof cause.stack !== "string") return [];
  return cause.stack.split("\n").flatMap((line) => Option.toArray(projectStackLine(line)));
};

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

const spanAttributes = (
  metadata: SpanDescriptor["metadata"]
): Readonly<Record<string, string | number | boolean>> => {
  switch (metadata._tag) {
    case "None":
      return {};
    case "Http":
      return {
        "http.request.method": metadata.method,
        ...Option.match(metadata.status, {
          onNone: () => ({}),
          onSome: (value) => ({ "http.response.status_code": value }),
        }),
      };
    case "Queue":
      return {
        "fidy.attempt": metadata.attempt,
        "fidy.input_count": metadata.inputCount,
        "fidy.delay_milliseconds": metadata.delayMilliseconds,
      };
    case "Provider":
      return {
        "fidy.provider": metadata.provider,
        "fidy.attempt": metadata.attempt,
        ...Option.match(metadata.status, {
          onNone: () => ({}),
          onSome: (value) => ({ "http.response.status_code": value }),
        }),
      };
    case "Model":
      return {
        "gen_ai.request.model": metadata.model,
        "fidy.attempt": metadata.attempt,
        "gen_ai.usage.input_tokens": metadata.inputTokens,
        "gen_ai.usage.output_tokens": metadata.outputTokens,
      };
    case "Schedule":
      return { "fidy.attempt": metadata.attempt };
  }
};

/** Exact allowlisted attributes permitted on a serialized transaction or final SDK span. */
export const ProjectedTraceData = Schema.Struct({
  "fidy.component": TelemetryCodeSchema.component,
  "fidy.operation": TelemetryCodeSchema.operation,
  "fidy.trigger": TelemetryCodeSchema.trigger,
  "fidy.work_kind": TelemetryCodeSchema.workKind,
  "fidy.outcome": TelemetryCodeSchema.outcome,
  "fidy.retryable": Schema.Boolean,
  "http.request.method": Schema.optionalKey(
    Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])
  ),
  "http.response.status_code": Schema.optionalKey(TelemetryHttpStatus),
  "fidy.provider": Schema.optionalKey(TelemetryCodeSchema.provider),
  "fidy.attempt": Schema.optionalKey(TelemetryAttempt),
  "fidy.input_count": Schema.optionalKey(TelemetryCount),
  "fidy.delay_milliseconds": Schema.optionalKey(TelemetryDuration),
  "gen_ai.request.model": Schema.optionalKey(TelemetryCodeSchema.model),
  "gen_ai.usage.input_tokens": Schema.optionalKey(TelemetryCount),
  "gen_ai.usage.output_tokens": Schema.optionalKey(TelemetryCount),
});
export type ProjectedTraceData = typeof ProjectedTraceData.Type;

/** Exact trace context and approved attributes permitted on a serialized transaction. */
export const ProjectedTrace = Schema.Struct({
  ...ProjectedTraceCoordinates,
  status: Schema.Literals(["ok", "invalid_argument", "internal_error", "cancelled"]),
  data: ProjectedTraceData,
});
export type ProjectedTrace = typeof ProjectedTrace.Type;

/** The exact root/child span shape allowed through the pinned SDK's final span hook. */
export const ProjectedFinalSpan = Schema.Struct({
  data: ProjectedTrace.fields.data,
  description: TelemetryCodeSchema.operation,
  op: TelemetryCodeSchema.spanOperation,
  parent_span_id: Schema.optionalKey(TelemetrySpanId),
  span_id: TelemetrySpanId,
  start_timestamp: Schema.Finite,
  status: Schema.Literals(["ok", "invalid_argument", "internal_error", "cancelled"]),
  timestamp: Schema.Finite,
  trace_id: TelemetryTraceId,
  is_segment: Schema.optionalKey(Schema.Boolean),
});
export type ProjectedFinalSpan = typeof ProjectedFinalSpan.Type;

const getUnknownProperty = (value: object, key: string): unknown =>
  Fn.cast<object, Readonly<Record<PropertyKey, unknown>>>(value)[key];

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
  if (typeof value !== "object" || value === null) return Option.none();
  return decodeStrict(ProjectedFinalSpan, {
    ...pickPresent(
      value,
      Object.keys(ProjectedFinalSpan.fields).filter((key) => key !== "data")
    ),
    data: projectFinalSpanData(getUnknownProperty(value, "data")),
  });
};

/** A complete metadata-only transaction reconstructed before the Sentry SDK boundary. */
export const ProjectedTransaction = Schema.Struct({
  type: Schema.Literal("transaction"),
  transaction: TelemetryCodeSchema.operation,
  transaction_info: Schema.Struct({ source: Schema.Literal("custom") }),
  start_timestamp: Schema.Finite,
  timestamp: Schema.Finite,
  contexts: Schema.Struct({ trace: ProjectedTrace }),
  tags: Schema.Struct({
    component: TelemetryCodeSchema.component,
    operation: TelemetryCodeSchema.operation,
    trigger: TelemetryCodeSchema.trigger,
    work_kind: TelemetryCodeSchema.workKind,
    outcome: TelemetryCodeSchema.outcome,
    retryable: Schema.Literals(["true", "false"]),
    error: Schema.optionalKey(TelemetryCodeSchema.error),
  }),
  breadcrumbs: Schema.Array(ProjectedBreadcrumb),
});
export type ProjectedTransaction = typeof ProjectedTransaction.Type;

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
}): Option.Option<ProjectedTransaction> =>
  Option.flatMap(decodeStrict(SpanDescriptor, input.descriptor), (descriptor) =>
    Option.map(decodeStrict(DeclaredOutcome, input.outcome), (outcome) => ({
      type: "transaction" as const,
      transaction: descriptor.operation,
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
          data: {
            "fidy.component": descriptor.component,
            "fidy.operation": descriptor.operation,
            "fidy.trigger": descriptor.trigger,
            "fidy.work_kind": descriptor.workKind,
            "fidy.outcome": outcome.outcome,
            "fidy.retryable": outcome.retryable,
            ...spanAttributes(descriptor.metadata),
          },
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
    }))
  );

/** A classified error event containing only stable codes and sanitized stack coordinates. */
export const ProjectedErrorEvent = Schema.Struct({
  timestamp: Schema.Finite,
  level: Schema.Literal("error"),
  exception: Schema.Struct({
    values: Schema.Tuple([
      Schema.Struct({
        type: Schema.Literals(["FidyDefect", "FidyOperationalFailure"]),
        value: Schema.Literals(["Unexpected defect", "Exhausted operational failure"]),
        stacktrace: Schema.Struct({ frames: Schema.Array(ProjectedStackFrame) }),
      }),
    ]),
  }),
  fingerprint: Schema.Tuple([
    TelemetryCodeSchema.component,
    TelemetryCodeSchema.operation,
    TelemetryCodeSchema.error,
  ]),
  tags: Schema.Struct({
    component: TelemetryCodeSchema.component,
    operation: TelemetryCodeSchema.operation,
    error: TelemetryCodeSchema.error,
    retryable: Schema.Literals(["true", "false"]),
    provider: Schema.optionalKey(TelemetryCodeSchema.provider),
  }),
  breadcrumbs: Schema.Array(ProjectedBreadcrumb),
  contexts: Schema.optionalKey(
    Schema.Struct({ trace: Schema.Struct(ProjectedErrorTraceCoordinates) })
  ),
});
export type ProjectedErrorEvent = typeof ProjectedErrorEvent.Type;

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
  readonly breadcrumbs: ReadonlyArray<ProjectedBreadcrumb>;
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
      breadcrumbs: input.breadcrumbs,
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
