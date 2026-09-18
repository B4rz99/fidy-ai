import * as Arr from "effect/Array";
import { Cause, Effect, type Exit, Option, Predicate, Schema } from "effect";
import { dual } from "effect/Function";
import { ErrorCode } from "~/shell/public-http/contract";
import { operationCatalog } from "~/shell/api";

type RequireNonEmpty = <Value>(
  values: ReadonlyArray<Value>
) => readonly [Value, ...ReadonlyArray<Value>];

const requireNonEmpty: RequireNonEmpty = function (values) {
  return Option.getOrThrowWith(
    Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty),
    () => new Error("Telemetry registry derivation requires canonical operations")
  );
};

const canonicalOperationCodes = operationCatalog.operations.map(({ id }) => id);
const canonicalHttpRoutes = requireNonEmpty(
  Array.from(new Set(operationCatalog.operations.map(({ route }) => route)))
);
const canonicalHttpRequests = requireNonEmpty(
  operationCatalog.operations.map(({ method, route }) => `${method} ${route}`)
);

/** Groups work kinds by the only metadata shape each kind may carry. */
export const TelemetryWorkKindGroup = {
  http: ["http_request"],
  queue: ["queue_publication", "queue_attempt"],
  provider: ["provider_call"],
  model: ["model_call"],
  schedule: ["scheduled_execution"],
  database: ["repository_operation"],
  none: ["canonical_operation", "authorization", "hosted_turn", "model_round", "ci_scenario"],
} as const;

/**
 * The complete vocabulary permitted to become indexed telemetry. Values are operational metadata,
 * never User, domain, provider-evidence, request, or payload data; additions require sentinel review.
 */
export const TelemetryRegistry = {
  component: [
    "browser",
    "api",
    "agent",
    "onboarding",
    "whatsapp",
    "postgres",
    "kapso",
    "mistral",
    "openai",
    "resend",
    "wompi",
    "ci",
  ],
  operation: [
    ...canonicalOperationCodes,
    "http.canonicalRequest",
    "http.supportRecovery",
    "http.kapsoWebhook",
    "http.kapsoIdentityWebhook",
    "authorization.agentBearer",
    "onboarding.deliverVerification",
    "agent.hostedTurn",
    "agent.modelRound",
    "whatsapp.publishTurn",
    "whatsapp.processTurn",
    "whatsapp.processWork",
    "whatsapp.sendText",
    "whatsapp.disclosureAttempt",
    "whatsapp.disclosureResume",
    "whatsapp.disclosureStart",
    "whatsapp.disclosureEvidence",
    "resend.forwardedEmailHandoff",
    "postgres.repositoryOperation",
    "postgres.compatibilityProbe",
    "task.auditRetention",
    "task.emailAuthenticationRetention",
    "task.onboardingRetention",
    "task.supportRecoveryRetention",
    "task.whatsappRetention",
    "task.billingReconciliationMaintenance",
    "task.durableQueueHealth",
    "provider.request",
    "observability.accountSmoke",
    "browserLogin.redeemPairing",
    "subscription.processBillingAttempt",
    "emailAuthentication.processPairingStart",
    "emailAuthentication.processPairingDelivery",
    "emailAuthentication.processPairingExpiry",
  ],
  trigger: ["api", "kapso_webhook", "queue", "schedule", "cli", "ci"],
  outcome: ["succeeded", "rejected", "failed", "interrupted"],
  error: [
    ...ErrorCode.literals,
    "unexpected_defect",
    "operational_failure",
    "database_unavailable",
    "provider_unavailable",
    "model_unavailable",
    "model_response_rejected",
    "unknown_user",
    "live_deadline_exhausted",
    "invalid_runtime_response",
    "sandbox_bsuid_unsupported",
    "invalid_recipient",
    "conversation_window_closed",
    "authentication_failed",
    "timeout",
    "invalid_response",
    "pairing_invalid",
    "capacity_exceeded",
    "disclosure_ambiguous",
    "disclosure_retrying",
    "disclosure_retry_exhausted",
    "disclosure_rejected",
    "disclosure_not_current",
  ],
  provider: ["cloudflare-access", "kapso", "mistral", "openai", "resend", "sentry", "wompi"],
  workKind: [
    ...TelemetryWorkKindGroup.http,
    ...TelemetryWorkKindGroup.queue,
    ...TelemetryWorkKindGroup.provider,
    ...TelemetryWorkKindGroup.model,
    ...TelemetryWorkKindGroup.schedule,
    ...TelemetryWorkKindGroup.database,
    ...TelemetryWorkKindGroup.none,
  ],
  httpRoute: [
    ...canonicalHttpRoutes,
    "/compatibility/:case",
    "/webhooks/kapso",
    "/web/pairings/redeem",
    "/internal/support-recovery",
  ],
  httpRequest: [
    ...canonicalHttpRequests,
    "GET /compatibility/:case",
    "POST /compatibility/:case",
    "DELETE /compatibility/:case",
    "POST /webhooks/kapso",
    "POST /web/pairings/redeem",
    "POST /internal/support-recovery",
  ],
  repositoryOperation: ["capture_transaction", "compatibility_probe"],
  databaseSystem: ["postgresql"],
  model: ["gpt_5_6_luna", "hosted_inference"],
  spanOperation: [
    "http.server",
    "http.client",
    "browser.navigation",
    "ui.action",
    "fidy.operation",
    "queue.publish",
    "queue.process",
    "task.scheduled",
    "agent.turn",
    "agent.model",
    "db",
    "test.e2e",
  ],
  breadcrumbCategory: ["operation", "queue", "provider", "agent", "consent", "deployment"],
  breadcrumbAction: [
    "operation_started",
    "operation_completed",
    "queue_published",
    "queue_claimed",
    "retry_started",
    "provider_started",
    "provider_completed",
    "model_started",
    "model_completed",
    "consent_checked",
    "deployment_started",
    "deployment_completed",
  ],
} as const;

type Registry = typeof TelemetryRegistry;

/** One literal from a named part of the telemetry registry. */
export type TelemetryCode<Key extends keyof Registry> = Registry[Key][number];

/** Runtime schemas derived from the same registry that supplies compile-time code unions. */
export const TelemetryCodeSchema = {
  component: Schema.Literals(TelemetryRegistry.component),
  operation: Schema.Literals(TelemetryRegistry.operation),
  trigger: Schema.Literals(TelemetryRegistry.trigger),
  outcome: Schema.Literals(TelemetryRegistry.outcome),
  error: Schema.Literals(TelemetryRegistry.error),
  provider: Schema.Literals(TelemetryRegistry.provider),
  workKind: Schema.Literals(TelemetryRegistry.workKind),
  httpRoute: Schema.Literals(TelemetryRegistry.httpRoute),
  httpRequest: Schema.Literals(TelemetryRegistry.httpRequest),
  repositoryOperation: Schema.Literals(TelemetryRegistry.repositoryOperation),
  databaseSystem: Schema.Literals(TelemetryRegistry.databaseSystem),
  model: Schema.Literals(TelemetryRegistry.model),
  spanOperation: Schema.Literals(TelemetryRegistry.spanOperation),
  breadcrumbCategory: Schema.Literals(TelemetryRegistry.breadcrumbCategory),
  breadcrumbAction: Schema.Literals(TelemetryRegistry.breadcrumbAction),
} as const;

/** Shared upper bound for every approved telemetry count. */
export const maximumTelemetryCount = 1_000_000;

/** Shared upper bound for every approved telemetry duration, in milliseconds. */
export const maximumTelemetryDurationMilliseconds = 86_400_000;

/** An integer count from zero through the shared telemetry-count maximum. */
export const TelemetryCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumTelemetryCount })
).pipe(Schema.brand("TelemetryCount"));
export type TelemetryCount = typeof TelemetryCount.Type;

/** Clamps any count reading into the approved telemetry-count range. */
export const boundedTelemetryCount = (value: number): TelemetryCount =>
  TelemetryCount.make(Math.min(Math.max(0, Math.trunc(value)), maximumTelemetryCount));

/** A one-based attempt number from 1 through 100 for queue, provider, model, or scheduled work. */
export const TelemetryAttempt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
).pipe(Schema.brand("TelemetryAttempt"));
export type TelemetryAttempt = typeof TelemetryAttempt.Type;

/** An elapsed duration from 0 through 86,400,000 ms; it carries no wall-clock timestamp. */
export const TelemetryDuration = Schema.Int.check(
  Schema.isBetween({
    minimum: 0,
    maximum: maximumTelemetryDurationMilliseconds,
  })
).pipe(Schema.brand("TelemetryDuration"));
export type TelemetryDuration = typeof TelemetryDuration.Type;

/** Clamps any millisecond reading into the approved telemetry-duration range. */
export const boundedTelemetryDuration = (value: number): TelemetryDuration =>
  TelemetryDuration.make(
    Math.min(Math.max(0, Math.trunc(value)), maximumTelemetryDurationMilliseconds)
  );

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
  delayMilliseconds: Schema.Option(TelemetryDuration),
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

const safeFunctionPattern = /^[A-Za-z_$][A-Za-z0-9_.$<>-]{0,119}$/u;
const safeSourceFilePattern = /^src\/[A-Za-z0-9_./-]{1,220}\.(?:ts|tsx|js|mjs)$/u;
const safeSourceModulePattern = /^src\/[A-Za-z0-9_./-]{1,220}$/u;

const PositiveStackCoordinate = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
);

/** Closed stack coordinates that cannot carry exception messages, source context, URLs, or locals. */
export const ProjectedStackFrame = Schema.Struct({
  module: Schema.String.check(Schema.isPattern(safeSourceModulePattern)),
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

/** Exact allowlisted attributes permitted on a serialized transaction or final SDK span. */
export const ProjectedTraceData = Schema.Struct({
  "fidy.component": TelemetryCodeSchema.component,
  "fidy.operation": TelemetryCodeSchema.operation,
  "fidy.trigger": TelemetryCodeSchema.trigger,
  "fidy.work_kind": TelemetryCodeSchema.workKind,
  "fidy.outcome": TelemetryCodeSchema.outcome,
  "fidy.retryable": Schema.Boolean,
  "http.request.method": Schema.optionalKey(TelemetryHttpMethod),
  "http.response.status_code": Schema.optionalKey(TelemetryHttpStatus),
  "http.response.status_class": Schema.optionalKey(TelemetryHttpStatusClass),
  "http.route": Schema.optionalKey(TelemetryCodeSchema.httpRoute),
  "db.system.name": Schema.optionalKey(TelemetryCodeSchema.databaseSystem),
  "fidy.repository_operation": Schema.optionalKey(TelemetryCodeSchema.repositoryOperation),
  "fidy.provider": Schema.optionalKey(TelemetryCodeSchema.provider),
  "fidy.attempt": Schema.optionalKey(TelemetryAttempt),
  "fidy.input_count": Schema.optionalKey(TelemetryCount),
  "fidy.delay_milliseconds": Schema.optionalKey(TelemetryDuration),
  "fidy.duration_milliseconds": Schema.optionalKey(TelemetryDuration),
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

const ProjectedSpanName = Schema.Union([
  TelemetryCodeSchema.operation,
  TelemetryCodeSchema.httpRequest,
]);

/** The exact root/child span shape allowed through the pinned SDK's final span hook. */
export const ProjectedFinalSpan = Schema.Struct({
  data: ProjectedTrace.fields.data,
  description: ProjectedSpanName,
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

/** A complete metadata-only transaction reconstructed before the Sentry SDK boundary. */
export const ProjectedTransaction = Schema.Struct({
  type: Schema.Literal("transaction"),
  transaction: ProjectedSpanName,
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

/** A classified error event containing only stable codes and sanitized stack coordinates. */
export const ProjectedErrorEvent = Schema.Struct({
  timestamp: Schema.Finite,
  level: Schema.Literal("error"),
  exception: Schema.Struct({
    values: Schema.Tuple([
      Schema.Struct({
        type: Schema.Literals(["FidyDefect", "FidyOperationalFailure"]),
        value: Schema.Literals(["Unexpected defect", "Exhausted operational failure"]),
        stacktrace: Schema.Struct({
          frames: Schema.Array(ProjectedStackFrame),
        }),
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
  contexts: Schema.optionalKey(
    Schema.Struct({ trace: Schema.Struct(ProjectedErrorTraceCoordinates) })
  ),
});
export type ProjectedErrorEvent = typeof ProjectedErrorEvent.Type;

/** Fail-closed decoding shared by every untrusted Observability projection. */
export const TelemetryStrictDecoding = { onExcessProperty: "error" } as const;

const stackSourceFilePattern = /^src\/[A-Za-z0-9_./-]{1,220}\.(?:ts|tsx|js|mjs)$/u;
const stackLinePattern = /^\s*at\s+(?:([^\s(]+)\s+\()?(.+):(\d+):(\d+)\)?\s*$/u;

const normalizeSourceFile = (value: string): Option.Option<string> => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return Option.none();
  const sourceMarker = value.lastIndexOf("/src/");
  const relative = sourceMarker >= 0 ? value.slice(sourceMarker + 1) : value;
  if (relative.split("/").some((segment) => segment === "." || segment === "..")) {
    return Option.none();
  }
  return stackSourceFilePattern.test(relative) ? Option.some(relative) : Option.none();
};

const projectStackLine = (line: string): Option.Option<ProjectedStackFrame> => {
  const match = stackLinePattern.exec(line);
  if (match === null) return Option.none();
  return Option.flatMap(Option.fromUndefinedOr(match[2]), (sourceFile) =>
    Option.flatMap(normalizeSourceFile(sourceFile), (filename) =>
      Schema.decodeOption(
        ProjectedStackFrame,
        TelemetryStrictDecoding
      )({
        module: filename.slice(0, filename.lastIndexOf(".")),
        filename,
        function: match[1] ?? "anonymous",
        lineno: Number(match[3]),
        colno: Number(match[4]),
      })
    )
  );
};

const stackText = (cause: unknown): Option.Option<string> => {
  if (!Predicate.isObject(cause)) return Option.none();
  try {
    if (!Predicate.hasProperty(cause, "stack")) return Option.none();
    return Predicate.isString(cause.stack) ? Option.some(cause.stack) : Option.none();
  } catch {
    return Option.none();
  }
};

const projectReasonStack = (reason: Cause.Reason<unknown>): ReadonlyArray<ProjectedStackFrame> => {
  if (Cause.isFailReason(reason)) return projectStack(reason.error);
  if (Cause.isDieReason(reason)) return projectStack(reason.defect);
  return [];
};

/** Extracts only scrubbed application coordinates from stack-bearing data. */
export const projectStack = (cause: unknown): ReadonlyArray<ProjectedStackFrame> => {
  if (Cause.isCause(cause)) {
    const direct = cause.reasons.flatMap(projectReasonStack);
    return direct.length > 0 ? direct : Cause.prettyErrors(cause).flatMap(projectStack);
  }
  return Option.match(stackText(cause), {
    onNone: () => [],
    onSome: (stack) => stack.split("\n").flatMap((line) => Option.toArray(projectStackLine(line))),
  });
};

type ExternalHttpRequestAttributes = Readonly<{
  "fidy.provider": TelemetryCode<"provider">;
  "http.request.method": TelemetryExternalHttpMethod;
}>;
type ExternalHttpResponseAttributes = Readonly<
  Partial<{ "http.response.status_class": TelemetryHttpStatusClass }>
>;
type ExternalHttpOutcomeAttributes = Readonly<{
  "fidy.transport_outcome": TelemetryTransportOutcome;
}>;

const firstSuccessStatus = 200;
const firstRedirectStatus = 300;
const firstClientErrorStatus = 400;
const firstServerErrorStatus = 500;

/** Projects an allowed HTTP status into its bounded status-class coordinate. */
export const projectHttpStatusClass = (status: TelemetryHttpStatus): TelemetryHttpStatusClass => {
  if (status < firstSuccessStatus) return "1xx";
  if (status < firstRedirectStatus) return "2xx";
  if (status < firstClientErrorStatus) return "3xx";
  if (status < firstServerErrorStatus) return "4xx";
  return "5xx";
};

/** Projects a provider request into its closed method and provider coordinates. */
export const projectExternalHttpRequest: {
  (
    provider: TelemetryCode<"provider">
  ): (method: TelemetryExternalHttpMethod) => ExternalHttpRequestAttributes;
  (
    method: TelemetryExternalHttpMethod,
    provider: TelemetryCode<"provider">
  ): ExternalHttpRequestAttributes;
} = dual(2, (method: TelemetryExternalHttpMethod, provider: TelemetryCode<"provider">) => ({
  "fidy.provider": provider,
  "http.request.method": method,
}));

/** Projects a response status into its low-cardinality status class. */
export const projectExternalHttpResponse = (status: number): ExternalHttpResponseAttributes =>
  Option.match(Schema.decodeOption(TelemetryHttpStatus, TelemetryStrictDecoding)(status), {
    onNone: () => ({}),
    onSome: (value) => ({ "http.response.status_class": projectHttpStatusClass(value) }),
  });

/** Projects transport completion into its closed outcome coordinate. */
export const projectExternalHttpOutcome = (
  outcome: TelemetryTransportOutcome
): ExternalHttpOutcomeAttributes => ({ "fidy.transport_outcome": outcome });

/** No-op adapter resource for tests and disabled runtime configuration. */
export const DisabledTelemetryResource: TelemetryResource = {
  adapter: {
    startSpan: () => Effect.succeedNone,
    finishSpan: () => Effect.void,
    recordOutcome: () => Effect.void,
    recordResponseStatus: () => Effect.void,
    captureFailure: () => Effect.void,
    addBreadcrumb: () => Effect.void,
    recordModelUsage: () => Effect.void,
  },
  close: Effect.void,
};
