import { Schema } from "effect";

export const CanaryPayload = Schema.Struct({
  version: Schema.Literal(1),
  sentAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CanaryPayload = typeof CanaryPayload.Type;

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

export type AlertSignal = OperationalSignal | CapabilityProbe;

export type OperationalSeverity = "none" | "warning" | "critical";

export type CapabilityProbe = Readonly<{
  component: "capability";
  operation: "requiredBindings" | "coordination" | "providerConfig";
  state: "healthy" | "unavailable";
}>;

export const CoreRejectionBoundary = Schema.Literals(["http", "providerCallback", "mcp"]);

export type CoreRejectionBoundary = typeof CoreRejectionBoundary.Type;
