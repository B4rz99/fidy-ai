import { DateTime, Effect, Layer } from "effect";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import {
  getBillingReconciliationEscalations,
  pruneBillingAttemptQueueHistory,
  retireExhaustedBillingAttemptWork,
} from "./billing-repo";

const escalationCadence = "1 hour";

/**
 * Surfaces bounded cross-User counts and maximum ages for BillingAttempts an operator must resolve.
 * Three buckets map to the escalation ladder: awaiting-reference (an armed charge with no provider
 * reference), provider-stalled (a known PENDING transaction past 24 hours, the escalation warning),
 * and manual-reconciliation (past the 7-day tracking age, or retired after queue exhaustion, and
 * already handed to an operator). It identifies no User or attempt, never mutates, and a missed
 * tick only delays visibility.
 */
const observeBillingReconciliationEscalations = Effect.fn(
  "Subscription.observeBillingReconciliationEscalations"
)(function* () {
  const escalations = yield* getBillingReconciliationEscalations();
  const total =
    escalations.awaitingReferenceCount +
    escalations.providerStalledCount +
    escalations.manualReconciliationCount;
  if (total === 0) return;
  yield* Effect.logWarning("BillingAttempt reconciliation requires operational attention").pipe(
    Effect.annotateLogs({
      work_kind: "billing-reconciliation",
      awaiting_reference_count: escalations.awaitingReferenceCount,
      awaiting_reference_max_age_seconds: escalations.awaitingReferenceMaxAgeSeconds,
      provider_stalled_count: escalations.providerStalledCount,
      provider_stalled_max_age_seconds: escalations.providerStalledMaxAgeSeconds,
      manual_reconciliation_count: escalations.manualReconciliationCount,
      manual_reconciliation_max_age_seconds: escalations.manualReconciliationMaxAgeSeconds,
    })
  );
});

/** Hourly best-effort reconciliation maintenance; it never arms a charge or submits provider work. */
const runBillingReconciliationMaintenance = Effect.fn(
  "Subscription.runBillingReconciliationMaintenance"
)(function* () {
  yield* observeBillingReconciliationEscalations();
  const now = yield* DateTime.now;
  // Exhaustion retirement never re-arms: a pending attempt gains manual-reconciliation evidence
  // while keeping its pending status, so late settlement still converges and no second charge
  // is submitted. Completed queue history is pruned only after the owning attempt is terminal.
  yield* retireExhaustedBillingAttemptWork(now);
  yield* pruneBillingAttemptQueueHistory(now);
});

const scheduledBillingReconciliationMaintenance = runBillingReconciliationMaintenance().pipe(
  runScheduledWork({
    component: "api",
    schedule: "task.billingReconciliationMaintenance",
    operationalError: "operational_failure",
  }),
  // A missed tick only delays visibility, so one failure must never end the hourly loop.
  Effect.ignoreCause
);

export const BillingReconciliationMaintenanceLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: escalationCadence,
    work: scheduledBillingReconciliationMaintenance,
  }).pipe(Effect.forkScoped)
);
