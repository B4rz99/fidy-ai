import { Schema } from "effect";
import type { OperationalSignal, PendingSignal } from "./operational-health";
import type { EventMetricSignal } from "./operational-event-metrics";
import type { CanaryHealth } from "./operational-canary";
import type { CapabilityProbe } from "./operational-probes";

export type AlertSignal = OperationalSignal | EventMetricSignal | CanaryHealth | CapabilityProbe;

/** Alert coordinates are finite kind/owner pairs; invalid cross-products cannot be delivered. */
const anyOwner = Schema.Literals([
  "onboarding",
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
  "whatsapp",
  "deadLetters",
  "retention",
  "onboardingQueue",
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
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
  "onboarding",
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
]);
const emailProofOwner = Schema.Literals(["onboarding", "browserPairing", "emailReplacement"]);
const workflowOwner = Schema.Literals([
  "onboarding",
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "workflowFailures",
]);
const queueOwner = Schema.Literals([
  "onboardingQueue",
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
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

const warningAgeMs = 120_000;
const criticalAgeMs = 600_000;
const rejectedEmailWarningCount = 5;
const retentionWarningAgeMs = 3_600_000;
const retentionCriticalAgeMs = 86_400_000;
const queueWarningCount = 100;
const queueCriticalCount = 1_000;

const isEmailProofOwner = (
  owner: PendingSignal["operation"]
): owner is "onboarding" | "browserPairing" | "emailReplacement" =>
  owner === "onboarding" || owner === "browserPairing" || owner === "emailReplacement";

const pendingWorkflowAlerts = (signal: PendingSignal): ReadonlyArray<OperationalAlert> =>
  signal.operation !== "forwardedEmail" && signal.failedWorkflows > 0
    ? [{ kind: "workflow_failure", owner: signal.operation, severity: "critical" }]
    : [];

const pendingAlerts = (signal: PendingSignal): ReadonlyArray<OperationalAlert> => {
  const owner = signal.operation;
  const alerts: OperationalAlert[] = [...pendingWorkflowAlerts(signal)];
  if (isEmailProofOwner(owner) && signal.sampledRejectedEmailWork >= rejectedEmailWarningCount) {
    alerts.push({ kind: "rejected_email_work", owner, severity: "warning" });
  }
  if (signal.oldestPendingAgeMilliseconds >= warningAgeMs || signal.expiredUndelivered > 0) {
    alerts.push({
      kind: "pending_work",
      owner,
      severity:
        signal.oldestPendingAgeMilliseconds >= criticalAgeMs || signal.expiredUndelivered > 0
          ? "critical"
          : "warning",
    });
  }
  return alerts;
};

const whatsappAlerts = (
  signal: Extract<OperationalSignal, { operation: "whatsapp"; state: "healthy" | "attention" }>
): ReadonlyArray<OperationalAlert> => {
  const owner = signal.operation;
  if (signal.sampledFailed > 0 || signal.overdueCleanup > 0) {
    return [{ kind: "whatsapp_delivery", owner, severity: "critical" }];
  }
  if (signal.oldestPendingAgeMilliseconds >= warningAgeMs) {
    return [
      {
        kind: "pending_work",
        owner,
        severity: signal.oldestPendingAgeMilliseconds >= criticalAgeMs ? "critical" : "warning",
      },
    ];
  }
  return [];
};

const queueAlerts = (
  signal: Extract<OperationalSignal, { backlogCount: number }>
): ReadonlyArray<OperationalAlert> => {
  if (signal.operation === "deadLetters") {
    return signal.backlogCount > 0
      ? [{ kind: "dead_letters", owner: signal.operation, severity: "critical" }]
      : [];
  }
  return signal.backlogCount >= queueWarningCount
    ? [
        {
          kind: "queue_backlog",
          owner: signal.operation,
          severity: signal.backlogCount >= queueCriticalCount ? "critical" : "warning",
        },
      ]
    : [];
};

const asyncAlerts = (
  signal: Extract<OperationalSignal, { state: "healthy" | "attention" }>
): ReadonlyArray<OperationalAlert> => {
  if ("backlogCount" in signal) return queueAlerts(signal);
  if (signal.operation === "whatsapp") return whatsappAlerts(signal);
  if (signal.operation === "retention") {
    return signal.oldestOverdueAgeMilliseconds >= retentionWarningAgeMs
      ? [
          {
            kind: "retention_lag",
            owner: signal.operation,
            severity:
              signal.oldestOverdueAgeMilliseconds >= retentionCriticalAgeMs
                ? "critical"
                : "warning",
          },
        ]
      : [];
  }
  return pendingAlerts(signal);
};

const alertsForSignal = (signal: AlertSignal): ReadonlyArray<OperationalAlert> => {
  if (signal.state === "unavailable") {
    return [{ kind: "inspection_unavailable", owner: signal.operation, severity: "warning" }];
  }
  if (signal.component === "workflow-execution") {
    return signal.recentCount > 0
      ? [{ kind: "workflow_failure", owner: signal.operation, severity: "critical" }]
      : [];
  }
  if (signal.component === "capability") {
    return signal.state === "attention"
      ? [{ kind: "capability_unusable", owner: signal.operation, severity: "critical" }]
      : [];
  }
  return asyncAlerts(signal);
};

/** Classifies already-bounded inspection results; unavailable is never interpreted as zero. */
export const decideOperationalAlerts = (
  signals: ReadonlyArray<AlertSignal>
): ReadonlyArray<OperationalAlert> => signals.flatMap(alertsForSignal);
