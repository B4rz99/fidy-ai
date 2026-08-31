import { Schema } from "effect";
import { TelemetryCodeSchema, TelemetryWorkKindGroup } from "./registry";

/** Shared upper bound for every approved telemetry count. */
export const maximumTelemetryCount = 1_000_000;

/** An integer count from zero through the shared telemetry-count maximum. */
export const TelemetryCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumTelemetryCount })
).pipe(Schema.brand("TelemetryCount"));
export type TelemetryCount = typeof TelemetryCount.Type;

/** A one-based attempt number from 1 through 100 for queue, provider, model, or scheduled work. */
export const TelemetryAttempt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
).pipe(Schema.brand("TelemetryAttempt"));
export type TelemetryAttempt = typeof TelemetryAttempt.Type;

/** An elapsed duration from 0 through 86,400,000 ms; it carries no wall-clock timestamp. */
export const TelemetryDuration = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 86_400_000 })
).pipe(Schema.brand("TelemetryDuration"));
export type TelemetryDuration = typeof TelemetryDuration.Type;

/** An HTTP response status from 100 through 599 used only as bounded diagnostic metadata. */
export const TelemetryHttpStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 100, maximum: 599 })
).pipe(Schema.brand("TelemetryHttpStatus"));
export type TelemetryHttpStatus = typeof TelemetryHttpStatus.Type;

/** Low-cardinality class of a validated provider HTTP response status. */
export const TelemetryHttpStatusClass = Schema.Literals(["1xx", "2xx", "3xx", "4xx", "5xx"]);
export type TelemetryHttpStatusClass = typeof TelemetryHttpStatusClass.Type;

/** Closed transport outcomes emitted by protected external HTTP spans. */
export const TelemetryTransportOutcome = Schema.Literals(["response", "failure", "interrupted"]);
export type TelemetryTransportOutcome = typeof TelemetryTransportOutcome.Type;

/** HTTP methods admitted by the assembled canonical API. */
export const TelemetryHttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type TelemetryHttpMethod = typeof TelemetryHttpMethod.Type;

/** Closed HTTP method vocabulary admitted for external provider requests. */
export const TelemetryExternalHttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);
export type TelemetryExternalHttpMethod = typeof TelemetryExternalHttpMethod.Type;

const NoSpanMetadata = Schema.TaggedStruct("None", {});
const HttpSpanMetadata = Schema.TaggedStruct("Http", {
  method: TelemetryHttpMethod,
  route: TelemetryCodeSchema.httpRoute,
  status: Schema.Option(TelemetryHttpStatus),
});
const DatabaseSpanMetadata = Schema.TaggedStruct("Database", {
  system: TelemetryCodeSchema.databaseSystem,
  repositoryOperation: TelemetryCodeSchema.repositoryOperation,
});
const QueueSpanMetadata = Schema.TaggedStruct("Queue", {
  attempt: TelemetryAttempt,
  inputCount: TelemetryCount,
  delayMilliseconds: TelemetryDuration,
});
const ProviderSpanMetadata = Schema.TaggedStruct("Provider", {
  provider: TelemetryCodeSchema.provider,
  attempt: TelemetryAttempt,
  status: Schema.Option(TelemetryHttpStatus),
});
const ModelSpanMetadata = Schema.TaggedStruct("Model", {
  model: TelemetryCodeSchema.model,
});

/** Completion-only counters attached to the active approved model span. */
export const TelemetryModelUsage = Schema.Struct({
  attempt: TelemetryAttempt,
  inputTokens: TelemetryCount,
  outputTokens: TelemetryCount,
});
export type TelemetryModelUsage = typeof TelemetryModelUsage.Type;
const ScheduleSpanMetadata = Schema.TaggedStruct("Schedule", {
  attempt: TelemetryAttempt,
});

const SpanIdentity = {
  component: TelemetryCodeSchema.component,
  operation: TelemetryCodeSchema.operation,
  trigger: TelemetryCodeSchema.trigger,
  spanOperation: TelemetryCodeSchema.spanOperation,
} as const;

/**
 * Describes one bounded shell operation. Each work kind admits only its relevant closed metadata
 * shape, preventing unrelated numeric or provider fields from entering a span.
 */
export const SpanDescriptor = Schema.Union([
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.http),
    metadata: HttpSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.database),
    metadata: DatabaseSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.queue),
    metadata: QueueSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.provider),
    metadata: ProviderSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.model),
    metadata: ModelSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.schedule),
    metadata: ScheduleSpanMetadata,
  }),
  Schema.Struct({
    ...SpanIdentity,
    workKind: Schema.Literals(TelemetryWorkKindGroup.none),
    metadata: NoSpanMetadata,
  }),
]);
export type SpanDescriptor = typeof SpanDescriptor.Type;

/** A caller's classification of an expected or terminal operation result. */
export const DeclaredOutcome = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("succeeded"),
    error: Schema.Option(Schema.Never),
    retryable: Schema.Literal(false),
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    error: Schema.Option(TelemetryCodeSchema.error),
    retryable: Schema.Literal(false),
  }),
  Schema.Struct({
    outcome: Schema.Literal("failed"),
    error: Schema.Option(TelemetryCodeSchema.error),
    retryable: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("interrupted"),
    error: Schema.Option(Schema.Never),
    retryable: Schema.Literal(false),
  }),
]);
export type DeclaredOutcome = typeof DeclaredOutcome.Type;

/**
 * An already-classified failure. `cause` is source material for stack coordinates only: its message,
 * properties, local variables, source context, and nested application values are never projected.
 */
export const ClassifiedFailure = Schema.Union([
  Schema.TaggedStruct("Defect", {
    component: TelemetryCodeSchema.component,
    operation: TelemetryCodeSchema.operation,
    error: TelemetryCodeSchema.error,
    cause: Schema.Unknown,
  }),
  Schema.TaggedStruct("ExhaustedOperationalFailure", {
    component: TelemetryCodeSchema.component,
    operation: TelemetryCodeSchema.operation,
    error: TelemetryCodeSchema.error,
    provider: Schema.Option(TelemetryCodeSchema.provider),
    retryable: Schema.Boolean,
    cause: Schema.Unknown,
  }),
]);
export type ClassifiedFailure = typeof ClassifiedFailure.Type;

/**
 * An approved diagnostic breadcrumb. It has no message or arbitrary data map; all optional values
 * are fixed codes or bounded numbers and only attach to the currently active telemetry span.
 */
export const TelemetryBreadcrumb = Schema.Struct({
  category: TelemetryCodeSchema.breadcrumbCategory,
  action: TelemetryCodeSchema.breadcrumbAction,
  component: TelemetryCodeSchema.component,
  outcome: Schema.Option(TelemetryCodeSchema.outcome),
  error: Schema.Option(TelemetryCodeSchema.error),
  attempt: Schema.Option(TelemetryAttempt),
  durationMilliseconds: Schema.Option(TelemetryDuration),
});
export type TelemetryBreadcrumb = typeof TelemetryBreadcrumb.Type;

/** A lowercase 32-hex trace identifier; callers obtain it from Telemetry, never application data. */
export const TelemetryTraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)).pipe(
  Schema.brand("TelemetryTraceId")
);
/** A lowercase 16-hex span identifier; callers obtain it from Telemetry, never application data. */
export const TelemetrySpanId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u)).pipe(
  Schema.brand("TelemetrySpanId")
);

/**
 * Exact propagation data allowed across a trusted Fidy durable boundary. Its millisecond timestamp
 * bounds continuation age without serializing baggage, identities, URLs, or provider metadata.
 */
export const DurableTraceContext = Schema.Struct({
  version: Schema.Literal(1),
  traceId: TelemetryTraceId,
  parentSpanId: TelemetrySpanId,
  sampled: Schema.Boolean,
  capturedAtUnixMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 })),
});
export type DurableTraceContext = typeof DurableTraceContext.Type;
