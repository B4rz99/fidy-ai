import { Effect, Layer } from "effect";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { getBillingReconciliationEscalations } from "./billing-repo";

const escalationCadence = "1 hour";

/**
 * Surfaces bounded cross-User counts and maximum ages for BillingAttempts an operator must resolve.
 * Three buckets map to the escalation ladder: awaiting-reference (an armed charge with no provider
 * reference), provider-stalled (a known PENDING transaction past 24 hours, the escalation warning),
 * and manual-reconciliation (past the 7-day tracking age and already handed to an operator). It
 * identifies no User or attempt, never mutates, and a missed tick only delays visibility.
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

/** Hourly best-effort escalation probe; it owns no lifecycle and can never authorize or stop work. */
const probeBillingReconciliationEscalations = observeBillingReconciliationEscalations().pipe(
  runScheduledWork({
    component: "api",
    schedule: "task.billingReconciliationEscalation",
    operationalError: "operational_failure",
  }),
  // A missed tick only delays visibility, so one failure must never end the hourly loop.
  Effect.ignoreCause
);

export const BillingReconciliationMaintenanceLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: escalationCadence,
    work: probeBillingReconciliationEscalations,
  }).pipe(Effect.forkScoped)
);
