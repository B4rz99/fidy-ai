import { Function as Fn, Schema } from "effect";
import { ErrorCode } from "~/shell/_shared/errors";
import { type OperationId, operationCatalog } from "~/shell/api";

const canonicalOperationCodes = operationCatalog.operations.map(({ id }) =>
  Fn.cast<typeof id, OperationId>(id)
);
const canonicalHttpRoutes = Fn.cast<Array<string>, readonly [string, ...ReadonlyArray<string>]>(
  Array.from(new Set(operationCatalog.operations.map(({ route }) => route)))
);
const canonicalHttpRequests = Fn.cast<Array<string>, readonly [string, ...ReadonlyArray<string>]>(
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
    "whatsapp",
    "postgres",
    "kapso",
    "openai",
    "resend",
    "wompi",
    "ci",
  ],
  operation: [
    ...canonicalOperationCodes,
    "http.canonicalRequest",
    "http.kapsoWebhook",
    "http.kapsoIdentityWebhook",
    "authorization.agentBearer",
    "agent.hostedTurn",
    "agent.modelRound",
    "whatsapp.publishTurn",
    "whatsapp.processTurn",
    "whatsapp.sendText",
    "postgres.repositoryOperation",
    "postgres.compatibilityProbe",
    "task.auditRetention",
    "task.pendingConsentRetention",
    "task.whatsappRetention",
    "provider.request",
    "observability.accountSmoke",
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
  ],
  provider: ["kapso", "openai", "resend", "wompi"],
  workKind: [
    ...TelemetryWorkKindGroup.http,
    ...TelemetryWorkKindGroup.queue,
    ...TelemetryWorkKindGroup.provider,
    ...TelemetryWorkKindGroup.model,
    ...TelemetryWorkKindGroup.schedule,
    ...TelemetryWorkKindGroup.database,
    ...TelemetryWorkKindGroup.none,
  ],
  httpRoute: [...canonicalHttpRoutes, "/compatibility/:case"],
  httpRequest: [
    ...canonicalHttpRequests,
    "GET /compatibility/:case",
    "POST /compatibility/:case",
    "DELETE /compatibility/:case",
  ],
  repositoryOperation: ["capture_transaction", "compatibility_probe"],
  databaseSystem: ["postgresql"],
  model: ["gpt_5_6_luna"],
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
