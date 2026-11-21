import { Schema } from "effect";
import {
  DurableTraceContext,
  ProjectedTraceData,
  TelemetryBreadcrumb,
  TelemetryCodeSchema,
  TelemetryDuration,
  TelemetryRelease,
  TelemetrySpanId,
  TelemetryTraceId,
} from "../../../src/shell/observability/contract";

export type WorkerTelemetryEnvironment = {
  readonly RELEASE_GIT_SHA: string;
};

export const workerInternalTraceHeader = "x-fidy-traceparent";

const TraceCoordinates = {
  traceId: TelemetryTraceId,
  spanId: TelemetrySpanId,
  parentSpanId: Schema.optionalKey(TelemetrySpanId),
} as const;

export const WorkerTelemetryEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("span"),
    release: TelemetryRelease,
    ...TraceCoordinates,
    spanOperation: TelemetryCodeSchema.spanOperation,
    data: ProjectedTraceData,
    error: Schema.optionalKey(TelemetryCodeSchema.error),
    latencyMilliseconds: TelemetryDuration,
    breadcrumbs: Schema.Array(TelemetryBreadcrumb),
  }),
  Schema.Struct({
    event: Schema.Literal("failure"),
    release: TelemetryRelease,
    traceId: Schema.optionalKey(TelemetryTraceId),
    spanId: Schema.optionalKey(TelemetrySpanId),
    component: TelemetryCodeSchema.component,
    operation: TelemetryCodeSchema.operation,
    error: TelemetryCodeSchema.error,
    classification: Schema.Literals(["Defect", "ExhaustedOperationalFailure"]),
    provider: Schema.optionalKey(TelemetryCodeSchema.provider),
    retryable: Schema.Boolean,
  }),
]);

export type WorkerTelemetryEvent = typeof WorkerTelemetryEvent.Type;

export const WorkerTraceContinuation = Schema.Struct({
  parent: Schema.optionalKey(Schema.Unknown),
});

export type WorkerTraceContinuation = typeof WorkerTraceContinuation.Type;

export const WorkerTraceProjection = Schema.Struct({
  traceContext: Schema.optionalKey(DurableTraceContext),
});

export type WorkerTraceProjection = typeof WorkerTraceProjection.Type;
