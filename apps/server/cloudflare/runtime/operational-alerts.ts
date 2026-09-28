import { Schema } from "effect";
import type { OperationalSignal, PendingSignal } from "./operational-health";
import type { EventMetricSignal } from "./operational-event-metrics";
import type { CanaryHealth } from "./operational-canary";
import type { CapabilityProbe } from "./operational-probes";

export type AlertSignal = OperationalSignal | EventMetricSignal | CanaryHealth | CapabilityProbe;

/** Alert coordinates are a finite vocabulary; sampled counts and work identities never become dimensions. */
export const OperationalAlert = Schema.Struct({
  kind: Schema.Literals([
    "pending_work",
    "dead_letters",
    "workflow_failure",
    "rejected_email_work",
    "whatsapp_delivery",
    "inspection_unavailable",
    "retention_lag",
    "worker_exception",
    "resource_limit",
    "callback_rejection",
    "queue_backlog",
    "capability_unusable",
  ]),
  owner: Schema.Literals([
    "onboarding",
    "browserPairing",
    "emailReplacement",
    "billing",
    "statement",
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
  ]),
  severity: Schema.Literals(["warning", "critical"]),
});
export type OperationalAlert = typeof OperationalAlert.Type;

const warningAgeMs = 120_000;
const criticalAgeMs = 600_000;
const rejectedEmailWarningCount = 5;
const retentionWarningAgeMs = 3_600_000;
const retentionCriticalAgeMs = 86_400_000;
const workerWarningCount = 5;
const workerCriticalCount = 10;
const callbackWarningCount = 5;
const callbackCriticalCount = 20;
const queueWarningCount = 100;
const queueCriticalCount = 1_000;

const pendingAlerts = (signal: PendingSignal): ReadonlyArray<OperationalAlert> => {
  const owner = signal.operation;
  const alerts: OperationalAlert[] = [];
  if (signal.failedWorkflows > 0) {
    alerts.push({ kind: "workflow_failure", owner, severity: "critical" });
  }
  if (signal.sampledRejectedEmailWork >= rejectedEmailWarningCount) {
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

const workerExceptionAlerts = (
  signal: Extract<EventMetricSignal, { state: "healthy" | "attention" }>
): ReadonlyArray<OperationalAlert> =>
  signal.recentCount >= workerWarningCount
    ? [
        {
          kind: "worker_exception",
          owner: "workerExceptions",
          severity: signal.fiveMinuteCount >= workerCriticalCount ? "critical" : "warning",
        },
      ]
    : [];

const callbackRejectionAlerts = (
  signal: Extract<EventMetricSignal, { state: "healthy" | "attention" }>
): ReadonlyArray<OperationalAlert> =>
  signal.recentCount >= callbackWarningCount
    ? [
        {
          kind: "callback_rejection",
          owner: "callbackRejections",
          severity: signal.recentCount >= callbackCriticalCount ? "critical" : "warning",
        },
      ]
    : [];

const platformAlerts = (
  signal: Extract<EventMetricSignal, { state: "healthy" | "attention" }>
): ReadonlyArray<OperationalAlert> => {
  const owner = signal.operation;
  switch (owner) {
    case "workerExceptions":
      return workerExceptionAlerts(signal);
    case "resourceLimits":
      return signal.recentCount > 0
        ? [{ kind: "resource_limit", owner, severity: "critical" }]
        : [];
    case "callbackRejections":
      return callbackRejectionAlerts(signal);
    case "workflowFailures":
      return signal.recentCount > 0
        ? [{ kind: "workflow_failure", owner, severity: "critical" }]
        : [];
  }
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
  if (signal.component === "platform-events") return platformAlerts(signal);
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
