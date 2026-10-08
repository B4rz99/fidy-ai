import type { OperationalAlert, OperationalSignal, PendingSignal } from "../contract";

const warningAgeMs = 120_000;
const criticalAgeMs = 600_000;
const rejectedEmailWarningCount = 5;
const retentionWarningAgeMs = 3_600_000;
const retentionCriticalAgeMs = 86_400_000;
const queueWarningCount = 100;
const queueCriticalCount = 1_000;

const isEmailProofOwner = (
  owner: PendingSignal["operation"]
): owner is "browserPairing" | "emailReplacement" =>
  owner === "browserPairing" || owner === "emailReplacement";

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

export const asyncAlerts = (
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
