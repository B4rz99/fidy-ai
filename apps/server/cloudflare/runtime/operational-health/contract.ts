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

export type AlertSignal = OperationalSignal | CanaryHealth | CapabilityProbe;

export type OperationalSeverity = "none" | "warning" | "critical";

export const coordinatorProbeName = "operational-health-probe";

export type CapabilityProbe = Readonly<{
  component: "capability";
  operation: "d1" | "requiredBindings" | "coordination" | "providerConfig";
  state: "healthy" | "unavailable";
}>;

/** Selected by the owning adapter, never accepted from request headers or tool arguments. */
export const CoreRejectionBoundary = Schema.Literals(["http", "providerCallback", "mcp"]);
export type CoreRejectionBoundary = typeof CoreRejectionBoundary.Type;
