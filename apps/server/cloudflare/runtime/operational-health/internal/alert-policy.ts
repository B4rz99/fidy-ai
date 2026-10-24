import type {
  AlertSignal,
  OperationalSeverity,
  OperationalSignal,
  PendingSignal,
} from "../contract";

const warningAgeMs = 120_000;
const criticalAgeMs = 600_000;
const rejectedEmailWarningCount = 5;
const retentionWarningAgeMs = 3_600_000;
const retentionCriticalAgeMs = 86_400_000;
const queueWarningCount = 100;
const queueCriticalCount = 1_000;

const rejectedEmailWarning = (signal: PendingSignal): boolean =>
  (signal.operation === "browserPairing" || signal.operation === "emailReplacement") &&
  signal.sampledRejectedEmailWork >= rejectedEmailWarningCount;

const pendingSeverity = (signal: PendingSignal): OperationalSeverity => {
  if (
    signal.oldestPendingAgeMilliseconds >= criticalAgeMs ||
    signal.expiredUndelivered > 0 ||
    (signal.operation !== "forwardedEmail" && signal.failedWorkflows > 0)
  ) {
    return "critical";
  }
  return signal.oldestPendingAgeMilliseconds >= warningAgeMs ||
    signal.unavailableWorkflows > 0 ||
    rejectedEmailWarning(signal)
    ? "warning"
    : "none";
};

const whatsappSeverity = (
  signal: Extract<OperationalSignal, { operation: "whatsapp"; state: "healthy" | "attention" }>
): OperationalSeverity => {
  if (
    signal.sampledFailed > 0 ||
    signal.overdueCleanup > 0 ||
    signal.oldestPendingAgeMilliseconds >= criticalAgeMs
  ) {
    return "critical";
  }
  return signal.oldestPendingAgeMilliseconds >= warningAgeMs ? "warning" : "none";
};

const queueSeverity = (
  signal: Extract<OperationalSignal, { backlogCount: number }>
): OperationalSeverity => {
  if (signal.operation === "deadLetters") return signal.backlogCount > 0 ? "critical" : "none";
  if (signal.backlogCount >= queueCriticalCount) return "critical";
  return signal.backlogCount >= queueWarningCount ? "warning" : "none";
};

const retentionSeverity = (age: number): OperationalSeverity => {
  if (age >= retentionCriticalAgeMs) return "critical";
  return age >= retentionWarningAgeMs ? "warning" : "none";
};

/** Classify bounded observations without retaining alert coordinates or delivery state. */
export const signalSeverity = (signal: AlertSignal): OperationalSeverity => {
  if (signal.state === "unavailable") return "warning";
  if (signal.component === "capability") return "none";
  if ("backlogCount" in signal) return queueSeverity(signal);
  if (signal.operation === "retention") {
    return retentionSeverity(signal.oldestOverdueAgeMilliseconds);
  }
  if (signal.operation === "whatsapp") return whatsappSeverity(signal);
  return pendingSeverity(signal);
};
