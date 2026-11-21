import { TelemetryTraceId } from "~/shell/observability/trace/contract";
import * as Arr from "effect/Array";
import { type Effect, type Exit, Option, Schema } from "effect";
import { ErrorCode } from "~/shell/public-http/contract";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import canonicalMetadata from "./canonical-metadata.generated.json";

export { TelemetryTraceId } from "~/shell/observability/trace/contract";

type RequireNonEmpty = <Value>(
  values: ReadonlyArray<Value>
) => readonly [Value, ...ReadonlyArray<Value>];

const requireNonEmpty: RequireNonEmpty = function (values) {
  return Option.getOrThrowWith(
    Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty),
    () => new Error("Telemetry registry derivation requires canonical operations")
  );
};

const canonicalOperationCodes = canonicalMetadata.map(({ id }) => CanonicalOperationId.make(id));

const canonicalHttpRoutes = requireNonEmpty(
  Array.from(new Set(canonicalMetadata.map(({ route }) => route)))
);

const canonicalHttpRequests = requireNonEmpty(
  canonicalMetadata.map(({ method, route }) => `${method} ${route}`)
);

export const TelemetryWorkKindGroup = {
  http: ["http_request"],
  queue: ["queue_publication", "queue_attempt"],
  provider: ["provider_call"],
  model: ["model_call"],
  schedule: ["scheduled_execution"],
  database: ["repository_operation"],
  none: ["canonical_operation", "authorization", "hosted_turn", "model_round", "ci_scenario"],
} as const;

export const TelemetryRegistry = {
  component: ["browser", "api", "agent", "email", "whatsapp", "kapso", "resend", "wompi", "ci"],
  operation: [
    ...canonicalOperationCodes,
    "http.canonicalRequest",
    "http.supportRecovery",
    "http.kapsoWebhook",
    "http.kapsoIdentityWebhook",
    "authorization.agentBearer",
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
    "email.forwardedEmailHandoff",
    "task.auditRetention",
    "task.emailAuthenticationRetention",
    "task.supportRecoveryRetention",
    "task.whatsappRetention",
    "task.billingReconciliationMaintenance",
    "task.queueHealth",
    "connections.attemptRetention",
    "connections.grantCleanup",
    "provider.request",
    "observability.accountSmoke",
    "browserLogin.redeemPairing",
    "subscription.processBillingAttempt",
    "emailAuthentication.processPairingStart",
    "emailAuthentication.processPairingDelivery",
    "emailAuthentication.processPairingExpiry",
    "worker.public.fetch",
    "worker.core.fetch",
    "worker.core.queue",
    "worker.core.scheduled",
    "worker.core.maintenance",
    "workflow.browserPairingEmail",
    "workflow.emailReplacement",
    "workflow.billingCollection",
    "workflow.billingRefund",
    "workflow.proactivityDelivery",
    "workflow.statementExtraction",
    "workflow.operationalCanary",
    "workflow.releaseSmoke",
    "model.openAi",
    "worker.core.coordinator",
    "worker.core.alarm",
    "worker.email.receive",
    "worker.email.scheduled",
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
    "model_provider_quota_exceeded",
    "model_response_rejected",
    "model_tool_arguments_rejected",
    "model_provider_response_rejected",
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
  provider: [
    "bancolombia",
    "github",
    "cloudflare-access",
    "google",
    "microsoft",
    "cloudflare-workers",
    "openai",
    "kapso",
    "resend",
    "wompi",
  ],
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
  repositoryOperation: ["capture_transaction"],
  databaseSystem: ["sqlite"],
  model: ["openai", "hosted_inference"],
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

export type TelemetryCode<Key extends keyof Registry> = Registry[Key][number];

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

export const maximumTelemetryCount = 1_000_000;

export const maximumTelemetryDurationMilliseconds = 86_400_000;

export const TelemetryCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumTelemetryCount })
).pipe(Schema.brand("TelemetryCount"));

export type TelemetryCount = typeof TelemetryCount.Type;

export const boundedTelemetryCount = (value: number): TelemetryCount =>
  TelemetryCount.make(Math.min(Math.max(0, Math.trunc(value)), maximumTelemetryCount));

export const TelemetryAttempt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
).pipe(Schema.brand("TelemetryAttempt"));

export type TelemetryAttempt = typeof TelemetryAttempt.Type;

export const TelemetryDuration = Schema.Int.check(
  Schema.isBetween({
    minimum: 0,
    maximum: maximumTelemetryDurationMilliseconds,
  })
).pipe(Schema.brand("TelemetryDuration"));

export type TelemetryDuration = typeof TelemetryDuration.Type;

export const boundedTelemetryDuration = (value: number): TelemetryDuration =>
  TelemetryDuration.make(
    Math.min(Math.max(0, Math.trunc(value)), maximumTelemetryDurationMilliseconds)
  );

export const TelemetryGitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)).pipe(
  Schema.brand("TelemetryGitRevision")
);

export type TelemetryGitRevision = typeof TelemetryGitRevision.Type;

export const TelemetryRelease = Schema.Union([TelemetryGitRevision, Schema.Literal("unknown")]);

export type TelemetryRelease = typeof TelemetryRelease.Type;

export const TelemetryHttpStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 100, maximum: 599 })
).pipe(Schema.brand("TelemetryHttpStatus"));

export type TelemetryHttpStatus = typeof TelemetryHttpStatus.Type;

export const TelemetryHttpStatusClass = Schema.Literals(["1xx", "2xx", "3xx", "4xx", "5xx"]);

export type TelemetryHttpStatusClass = typeof TelemetryHttpStatusClass.Type;

export const TelemetrySpanId = Schema.String.check(
  Schema.isPattern(/^(?!0{16}$)[0-9a-f]{16}$/u)
).pipe(Schema.brand("TelemetrySpanId"));

export const TelemetryWorkRecord = Schema.Struct({
  release: TelemetryRelease,
  operation: TelemetryCodeSchema.operation,
  provider: Schema.optionalKey(TelemetryCodeSchema.provider),
  statusClass: Schema.optionalKey(TelemetryHttpStatusClass),
  outcome: TelemetryCodeSchema.outcome,
  attempt: TelemetryAttempt,
  latencyMilliseconds: TelemetryDuration,
  traceId: Schema.optionalKey(TelemetryTraceId),
  spanId: Schema.optionalKey(TelemetrySpanId),
});

export type TelemetryWorkRecord = typeof TelemetryWorkRecord.Type;

export const TelemetryWorkDescriptor = Schema.Struct({
  release: TelemetryRelease,
  operation: TelemetryCodeSchema.operation,
  provider: Schema.Option(TelemetryCodeSchema.provider),
  attempt: TelemetryAttempt,
});

export type TelemetryWorkDescriptor = typeof TelemetryWorkDescriptor.Type;

export type TelemetryWorkSuccess = Readonly<{
  outcome: Extract<TelemetryCode<"outcome">, "succeeded" | "rejected" | "failed">;
  statusClass: Option.Option<TelemetryHttpStatusClass>;
}>;

export type TelemetryWorkOptions<A> = Readonly<{
  descriptor: TelemetryWorkDescriptor;
  projectSuccess: (value: A) => TelemetryWorkSuccess;
}>;

export const TelemetryTransportOutcome = Schema.Literals(["response", "failure", "interrupted"]);

export type TelemetryTransportOutcome = typeof TelemetryTransportOutcome.Type;

export const TelemetryHttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type TelemetryHttpMethod = typeof TelemetryHttpMethod.Type;

export const TelemetryExternalHttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "QUERY",
  "TRACE",
]);

export type TelemetryExternalHttpMethod = typeof TelemetryExternalHttpMethod.Type;

export const NoSpanMetadata = Schema.TaggedStruct("None", {});

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

export const ProviderSpanMetadata = Schema.TaggedStruct("Provider", {
  provider: TelemetryCodeSchema.provider,
  attempt: TelemetryAttempt,
  status: Schema.Option(TelemetryHttpStatus),
});

const ModelSpanMetadata = Schema.TaggedStruct("Model", {
  model: TelemetryCodeSchema.model,
});

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
  release: Schema.optionalKey(TelemetryRelease),
  component: TelemetryCodeSchema.component,
  operation: TelemetryCodeSchema.operation,
  trigger: TelemetryCodeSchema.trigger,
  spanOperation: TelemetryCodeSchema.spanOperation,
} as const;

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

export const DefectFailure = Schema.TaggedStruct("Defect", {
  component: TelemetryCodeSchema.component,
  operation: TelemetryCodeSchema.operation,
  error: TelemetryCodeSchema.error,
  cause: Schema.Unknown,
});

export const ClassifiedFailure = Schema.Union([
  DefectFailure,
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

export const DurableTraceContext = Schema.Struct({
  version: Schema.Literal(1),
  traceId: TelemetryTraceId,
  parentSpanId: TelemetrySpanId,
  sampled: Schema.Boolean,
  capturedAtUnixMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 })),
});

export type DurableTraceContext = typeof DurableTraceContext.Type;

export const TelemetrySpan = Schema.Struct({
  traceId: DurableTraceContext.fields.traceId,
  spanId: DurableTraceContext.fields.parentSpanId,
  sampled: Schema.Boolean,
  state: Schema.Unknown,
});

export type TelemetrySpan = typeof TelemetrySpan.Type;

export type TelemetryAdapter = {
  readonly startSpan: (
    descriptor: SpanDescriptor,
    parent: Option.Option<DurableTraceContext>
  ) => Effect.Effect<Option.Option<TelemetrySpan>>;
  readonly finishSpan: (
    span: TelemetrySpan,
    exit: Exit.Exit<unknown, unknown>
  ) => Effect.Effect<void>;
  readonly recordOutcome: (span: TelemetrySpan, outcome: DeclaredOutcome) => Effect.Effect<void>;
  readonly recordResponseStatus: (
    span: TelemetrySpan,
    status: TelemetryHttpStatus
  ) => Effect.Effect<void>;
  readonly captureFailure: (
    span: Option.Option<TelemetrySpan>,
    failure: ClassifiedFailure
  ) => Effect.Effect<void>;
  readonly addBreadcrumb: (
    span: TelemetrySpan,
    breadcrumb: TelemetryBreadcrumb
  ) => Effect.Effect<void>;
  readonly recordModelUsage: (
    span: TelemetrySpan,
    usage: TelemetryModelUsage
  ) => Effect.Effect<void>;
  readonly exportWork: (record: TelemetryWorkRecord) => void;
};

export type TelemetryService = {
  readonly span: <A, E, R>(
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly observeWork: <A, E, R>(
    options: TelemetryWorkOptions<A>,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly rootSpan: <A, E, R>(
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly continueSpan: <A, E, R>(
    savedContext: unknown,
    descriptor: SpanDescriptor,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly recordOutcome: (outcome: DeclaredOutcome) => Effect.Effect<void>;
  readonly recordResponseStatus: (status: TelemetryHttpStatus) => Effect.Effect<void>;
  readonly captureFailure: (failure: ClassifiedFailure) => Effect.Effect<void>;
  readonly addBreadcrumb: (breadcrumb: TelemetryBreadcrumb) => Effect.Effect<void>;
  readonly recordModelUsage: (usage: TelemetryModelUsage) => Effect.Effect<void>;
  readonly captureDurableContext: Effect.Effect<Option.Option<DurableTraceContext>>;
  readonly isActiveSpan: (
    context: DurableTraceContext,
    operation: SpanDescriptor["operation"]
  ) => Effect.Effect<boolean>;
};

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

export const ProjectedStackFrame = Schema.Struct({
  module: Schema.String.check(Schema.isPattern(safeSourceModulePattern)),
  filename: Schema.String.check(Schema.isPattern(safeSourceFilePattern)),
  function: Schema.String.check(Schema.isPattern(safeFunctionPattern)),
  lineno: PositiveStackCoordinate,
  colno: PositiveStackCoordinate,
});

export type ProjectedStackFrame = typeof ProjectedStackFrame.Type;

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

const ProjectedErrorTraceCoordinates = {
  ...ProjectedTraceCoordinates,
  op: Schema.optionalKey(TelemetryCodeSchema.spanOperation),
} as const;

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

export const TelemetryStrictDecoding = { onExcessProperty: "error" } as const;

export type ExternalHttpRequestAttributes = Readonly<{
  "fidy.provider": TelemetryCode<"provider">;
  "http.request.method": TelemetryExternalHttpMethod;
}>;

export type ExternalHttpResponseAttributes = Readonly<
  Partial<{ "http.response.status_class": TelemetryHttpStatusClass }>
>;

export type ExternalHttpOutcomeAttributes = Readonly<{
  "fidy.transport_outcome": TelemetryTransportOutcome;
}>;
