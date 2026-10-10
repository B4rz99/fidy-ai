import { type Option, Schema } from "effect";

export const CanaryPayload = Schema.Struct({
  version: Schema.Literal(1),
  sentAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CanaryPayload = typeof CanaryPayload.Type;
export type CanaryHealth = Readonly<{
  component: "capability";
  operation: "queueExecution" | "workflowExecution";
}> &
  (
    | Readonly<{ state: "unavailable" }>
    | Readonly<{ state: "healthy" | "attention"; lastSucceededMs: number }>
  );

export const WorkKind = Schema.Literals([
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
  "proactivity",
]);
export type WorkKind = typeof WorkKind.Type;
export const QueueKind = Schema.Literals([
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
  "proactivityQueue",
]);
export type QueueKind = typeof QueueKind.Type;
/** Closed operational evidence. No identity, provider detail, proof, or financial value is exported. */
export type PendingSignal = Readonly<{
  component: "async-health";
  operation: WorkKind;
  state: "healthy" | "attention";
  sampledRejectedEmailWork: number;
  rejectionSampleLimited: boolean;
  sampledPending: number;
  sampleLimited: boolean;
  oldestPendingAgeMilliseconds: number;
  expiredUndelivered: number;
  failedWorkflows: number;
  unavailableWorkflows: number;
}>;

/** Unavailable measurements carry no invented zeroes; Queue totals are distinct from D1 samples. */
export type OperationalSignal =
  | PendingSignal
  | Readonly<{
      component: "async-health";
      operation: "deadLetters" | QueueKind;
      state: "healthy" | "attention";
      backlogCount: number;
      backlogBytes: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: "whatsapp";
      state: "healthy" | "attention";
      sampledPending: number;
      sampledFailed: number;
      overdueCleanup: number;
      sampleLimited: boolean;
      oldestPendingAgeMilliseconds: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: "retention";
      state: "healthy" | "attention";
      sampledOverdue: number;
      sampleLimited: boolean;
      oldestOverdueAgeMilliseconds: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: WorkKind | QueueKind | "whatsapp" | "deadLetters" | "retention";
      state: "unavailable";
    }>;

type WorkflowStatusBinding = Readonly<{
  get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
}>;
/** Private bindings used only for bounded metadata inspection, never replay or provider calls. */
export type OperationalHealthEnvironment = Readonly<{
  DB: D1Database;
  proactivity: Readonly<{ weeklyEnabled: boolean; proactivityEnabled: boolean }>;
  workflows: Partial<Record<Exclude<WorkKind, "forwardedEmail">, WorkflowStatusBinding>>;
  deadLetters: Option.Option<Pick<Queue, "metrics">>;
  workQueues: Partial<Record<QueueKind, Pick<Queue, "metrics">>>;
}>;

export type AlertSignal = OperationalSignal | EventMetricSignal | CanaryHealth | CapabilityProbe;

/** Alert coordinates are finite kind/owner pairs; invalid cross-products cannot be delivered. */
const anyOwner = Schema.Literals([
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
  "proactivity",
  "whatsapp",
  "deadLetters",
  "retention",
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
  "proactivityQueue",
  "workerExceptions",
  "resourceLimits",
  "callbackRejections",
  "workflowFailures",
  "queueExecution",
  "workflowExecution",
  "d1",
  "requiredBindings",
  "coordination",
  "providerConfig",
]);
const severity = Schema.Literals(["warning", "critical"]);
const workOwner = Schema.Literals([
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
  "proactivity",
]);
const emailProofOwner = Schema.Literals(["browserPairing", "emailReplacement"]);
const workflowOwner = Schema.Literals([
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "workflowFailures",
  "proactivity",
]);
const queueOwner = Schema.Literals([
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
  "proactivityQueue",
]);
export const OperationalAlert = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pending_work"),
    owner: Schema.Union([workOwner, Schema.Literal("whatsapp")]),
    severity,
  }),
  Schema.Struct({
    kind: Schema.Literal("dead_letters"),
    owner: Schema.Literal("deadLetters"),
    severity,
  }),
  Schema.Struct({ kind: Schema.Literal("workflow_failure"), owner: workflowOwner, severity }),
  Schema.Struct({ kind: Schema.Literal("rejected_email_work"), owner: emailProofOwner, severity }),
  Schema.Struct({
    kind: Schema.Literal("whatsapp_delivery"),
    owner: Schema.Literal("whatsapp"),
    severity,
  }),
  Schema.Struct({ kind: Schema.Literal("inspection_unavailable"), owner: anyOwner, severity }),
  Schema.Struct({
    kind: Schema.Literal("retention_lag"),
    owner: Schema.Literal("retention"),
    severity,
  }),
  // Existing Tail-only alert rows remain decodable so their delivery state can be retired cleanly.
  Schema.Struct({
    kind: Schema.Literal("worker_exception"),
    owner: Schema.Literal("workerExceptions"),
    severity,
  }),
  Schema.Struct({
    kind: Schema.Literal("resource_limit"),
    owner: Schema.Literal("resourceLimits"),
    severity,
  }),
  Schema.Struct({
    kind: Schema.Literal("callback_rejection"),
    owner: Schema.Literal("callbackRejections"),
    severity,
  }),
  Schema.Struct({ kind: Schema.Literal("queue_backlog"), owner: queueOwner, severity }),
  Schema.Struct({
    kind: Schema.Literal("capability_unusable"),
    owner: Schema.Literals(["queueExecution", "workflowExecution"]),
    severity,
  }),
]);
export type OperationalAlert = typeof OperationalAlert.Type;

export type OperationalAlertDelivery = Readonly<{
  db: D1Database;
  now: number;
  alerts: ReadonlyArray<OperationalAlert>;
  signal: AbortSignal;
  send: (
    alert: OperationalAlert,
    idempotencyKey: string,
    delivery: Readonly<{ signal: AbortSignal; phase: "firing" | "resolved" }>
  ) => Promise<void>;
}>;

export type EventMetricSignal = Readonly<{
  component: "workflow-execution";
  operation: "workflowFailures";
}> &
  (
    | Readonly<{ state: "unavailable" }>
    | Readonly<{ state: "healthy" | "attention"; recentCount: number; fiveMinuteCount: number }>
  );

export const coordinatorProbeName = "operational-health-probe";

export type CapabilityProbe = Readonly<{
  component: "capability";
  operation: "d1" | "requiredBindings" | "coordination" | "providerConfig";
  state: "healthy" | "unavailable";
}>;
