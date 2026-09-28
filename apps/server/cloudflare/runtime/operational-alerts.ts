import type { OperationalSignal, PendingSignal } from "./operational-health";

/** Alert coordinates are a finite vocabulary; sampled counts and work identities never become dimensions. */
export type OperationalAlert = Readonly<{
  kind:
    | "pending_work"
    | "dead_letters"
    | "workflow_failure"
    | "rejected_email_work"
    | "whatsapp_delivery"
    | "inspection_unavailable"
    | "retention_lag";
  owner: OperationalSignal["operation"];
  severity: "warning" | "critical";
}>;

const warningAgeMs = 120_000;
const criticalAgeMs = 600_000;
const rejectedEmailWarningCount = 5;
const retentionWarningAgeMs = 3_600_000;
const retentionCriticalAgeMs = 86_400_000;

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

const alertsForSignal = (signal: OperationalSignal): ReadonlyArray<OperationalAlert> => {
  if (signal.state === "unavailable") {
    return [{ kind: "inspection_unavailable", owner: signal.operation, severity: "warning" }];
  }
  if (signal.operation === "deadLetters") {
    return signal.backlogCount > 0
      ? [{ kind: "dead_letters", owner: signal.operation, severity: "critical" }]
      : [];
  }
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

/** Classifies already-bounded inspection results; unavailable is never interpreted as zero. */
export const decideOperationalAlerts = (
  signals: ReadonlyArray<OperationalSignal>
): ReadonlyArray<OperationalAlert> => signals.flatMap(alertsForSignal);
