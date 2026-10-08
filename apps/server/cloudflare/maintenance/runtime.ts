import { Clock, Effect, Option } from "effect";
import { makeAuditRetention } from "../../src/shell/audit/runtime";
import {
  type CoreMaintenanceInput,
  EmailScheduleUnavailable,
  type ScheduledActivity,
  type ScheduledOperation,
  type ScheduledWorkFailed,
} from "./contract";
import { executeSchedule } from "./operations";
import { sweepCanonicalAdmission } from "../canonical-admission/runtime";
import { sweepCommercialAllowances } from "../quotas/runtime";
import type { ForwardedEmailEnvironment } from "../ingestion/contract";
import type { PlatformMaintenance } from "../runtime/contract";
import { makePlatformMaintenance } from "../runtime/runtime";
import { makeAgentRetention } from "../agent/runtime";
import { sweepExpiredWorkersAiAdmission } from "../ai/runtime";
import { recoverPendingDisclosures, sweepExpiredConsent } from "../consent/ingress/runtime";
import {
  dispatchBrowserPairingEmail,
  dispatchEmailReplacement,
  dispatchOnboardingEmail,
  reconcileBrowserPairingEmail,
  reconcileEmailReplacement,
  reconcileOnboardingEmail,
} from "../email-authentication/runtime";
import {
  dispatchBillingCollection,
  dispatchBillingPriceNotices,
  dispatchRefunds,
  dispatchSubscriptionCancellations,
  dispatchSubscriptionRenewals,
  dispatchVoidVerification,
  reconcileBillingCandidates,
  sweepExpiredEnrollmentAdmission,
} from "../subscription/runtime";
import {
  dispatchForwardedEmail,
  dispatchStatementExtraction,
  expireStatementReviewEvidence,
  reconcileStatementExtraction,
  statementRetention,
  sweepExpiredUploadAdmission,
  sweepForwardedEmail,
  sweepMediaSubmissions,
} from "../ingestion/runtime";
import { sweepProactivityConsentOffers } from "../consent/runtime";
import { sweepExpiredPATPairings } from "../tokens/runtime";
import { sweepOAuthConfirmation } from "../oauth-confirmation/runtime";
import { sweepConnectionAttempts } from "../connections/runtime";
import { advanceProactivityWork } from "../insights/runtime";
import { advanceRecurringWork } from "../recurring/runtime";
import { repairDashboardProjections } from "../transactions/runtime";
import { dispatchWhatsAppWork, sweepExpiredWhatsAppWindows } from "../whatsapp/runtime";

const activity = <E>(
  operation: ScheduledOperation,
  work: Effect.Effect<unknown, E>
): ScheduledActivity => ({ operation, work: work.pipe(Effect.mapError(() => undefined)) });

const emailActivities = (environment: CoreMaintenanceInput): ReadonlyArray<ScheduledActivity> => [
  activity(
    "onboarding.email.dispatch",
    Option.match(environment.ONBOARDING_EMAIL_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchOnboardingEmail({
          DB: environment.DB,
          ONBOARDING_EMAIL_QUEUE: queue,
          identity: Option.none(),
        }),
    })
  ),
  activity("onboarding.email.reconcile", reconcileOnboardingEmail(environment.DB)),
  activity(
    "browserPairing.email.dispatch",
    Option.match(environment.BROWSER_PAIRING_EMAIL_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchBrowserPairingEmail({
          DB: environment.DB,
          BROWSER_PAIRING_EMAIL_QUEUE: queue,
          identity: Option.none(),
        }),
    })
  ),
  activity("browserPairing.email.reconcile", reconcileBrowserPairingEmail(environment.DB)),
  activity(
    "emailReplacement.dispatch",
    Option.match(environment.EMAIL_REPLACEMENT_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchEmailReplacement({
          DB: environment.DB,
          EMAIL_REPLACEMENT_QUEUE: queue,
          identity: Option.none(),
        }),
    })
  ),
  activity("emailReplacement.reconcile", reconcileEmailReplacement(environment.DB)),
];

const billingActivities = (environment: CoreMaintenanceInput): ReadonlyArray<ScheduledActivity> => [
  activity("billing.renewal.dispatch", dispatchSubscriptionRenewals(environment)),
  activity(
    "billing.cancellation.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchSubscriptionCancellations({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.priceNotice.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchBillingPriceNotices({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.refund.reconcile",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchVoidVerification({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.refund.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) => dispatchRefunds({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.collection.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchBillingCollection({
          DB: environment.DB,
          BILLING_COLLECTION_QUEUE: queue,
          identity: Option.none(),
        }),
    })
  ),
  activity(
    "billing.collection.reconcile",
    Option.match(environment.BILLING_COLLECTION_WORKFLOW, {
      onNone: () => Effect.void,
      onSome: (workflow) =>
        reconcileBillingCandidates({ DB: environment.DB, BILLING_COLLECTION_WORKFLOW: workflow }),
    })
  ),
];

const channelActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number
): ReadonlyArray<ScheduledActivity> => [
  activity("consent.sweep", sweepExpiredConsent(environment.DB)()),
  activity("consent.proactivityOfferRetention", sweepProactivityConsentOffers(environment.DB)),
  activity(
    "consent.disclosureRecovery",
    recoverPendingDisclosures({ db: environment.DB, apiKey: environment.KAPSO_API_KEY })
  ),
  activity(
    "hostedTurn.whatsapp.dispatch",
    Option.match(environment.HOSTED_WHATSAPP_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) => dispatchWhatsAppWork({ db: environment.DB, queue, userId: Option.none() }),
    })
  ),
  activity(
    "hostedTurn.whatsapp.windowSweep",
    sweepExpiredWhatsAppWindows({ db: environment.DB, now: nowEpochMs })
  ),
  activity("hostedTurn.sweep", makeAgentRetention({ db: environment.DB }).sweep(nowEpochMs)),
];

const stagingActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number
): ReadonlyArray<ScheduledActivity> => {
  const staging = Option.map(environment.STATEMENT_STAGING_BUCKET, (bucket) =>
    statementRetention({
      bucket,
      database: environment.DB,
      nowEpochMs: () => nowEpochMs,
    })
  );
  return [
    activity(
      "ingestion.submissionRetention",
      Option.match(staging, {
        onNone: () => Effect.void,
        onSome: (retention) => retention.expireSubmissions,
      })
    ),
    activity(
      "ingestion.stagingSweep",
      Option.match(staging, {
        onNone: () => Effect.void,
        onSome: (retention) => retention.sweepStaging,
      })
    ),
  ];
};

const admissionActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number,
  platform: PlatformMaintenance
): ReadonlyArray<ScheduledActivity> => [
  activity(
    "ingestion.mediaRetention",
    sweepMediaSubmissions({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "ingestion.uploadAdmissionSweep",
    sweepExpiredUploadAdmission({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "agent.workersAiAdmissionSweep",
    sweepExpiredWorkersAiAdmission({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "billing.cardPreparationAdmissionSweep",
    sweepExpiredEnrollmentAdmission({ db: environment.DB, now: nowEpochMs })
  ),
  activity("release.smoke.expiry", platform.expireSmokeProbes(nowEpochMs)),
  activity(
    "canonical.admissionRetention",
    sweepCanonicalAdmission({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "oauth.confirmationRetention",
    sweepOAuthConfirmation({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "connections.attemptRetention",
    sweepConnectionAttempts({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "quota.consumptionRetention",
    sweepCommercialAllowances({ db: environment.DB, current: nowEpochMs })
  ),
];

const statementActivities = (
  environment: CoreMaintenanceInput
): ReadonlyArray<ScheduledActivity> => [
  activity(
    "ingestion.reviewEvidenceExpiry",
    Option.match(environment.STATEMENT_STAGING_BUCKET, {
      onNone: () => Effect.void,
      onSome: () => expireStatementReviewEvidence({ DB: environment.DB }),
    })
  ),
  activity(
    "ingestion.statementReconcile",
    Option.match(environment.STATEMENT_EXTRACTION_WORKFLOW, {
      onNone: () => Effect.void,
      onSome: (workflow) =>
        reconcileStatementExtraction({
          DB: environment.DB,
          STATEMENT_EXTRACTION_WORKFLOW: workflow,
          USER_TRANSACTION_COORDINATOR: environment.USER_TRANSACTION_COORDINATOR,
        }),
    })
  ),
  activity(
    "ingestion.statementDispatch",
    Option.match(environment.STATEMENT_EXTRACTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchStatementExtraction({ DB: environment.DB, STATEMENT_EXTRACTION_QUEUE: queue }),
    })
  ),
];

/**
 * Run one Core tick through published owner runtimes. Work starts at execution time, with one
 * shared decision instant for sweeps that accept it. Owners retain their own policy and authority;
 * independent failures are reported only after the remaining activities have been attempted.
 */
export const runCoreMaintenance = (
  environment: CoreMaintenanceInput
): Effect.Effect<void, ScheduledWorkFailed> =>
  Effect.gen(function* () {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const platform = makePlatformMaintenance(environment);
    yield* executeSchedule([
      activity("async.health", platform.inspectHealth()),
      activity(
        "audit.retention",
        makeAuditRetention({ database: environment.DB }).sweep(nowEpochMs)
      ),
      activity("operational.events.retention", platform.retainEventBuckets(nowEpochMs)),
      activity("operational.canary.publish", platform.publishCanary(nowEpochMs)),
      ...emailActivities(environment),
      ...billingActivities(environment),
      ...channelActivities(environment, nowEpochMs),
      activity("patPairing.sweep", sweepExpiredPATPairings(environment.DB)),
      activity("dashboard.projectionRepair", repairDashboardProjections(environment.DB)),
      activity("recurring.evaluate", advanceRecurringWork(environment)),
      activity("insights.weekly.dispatch", advanceProactivityWork(environment)),
      ...stagingActivities(environment, nowEpochMs),
      ...admissionActivities(environment, nowEpochMs, platform),
      ...statementActivities(environment),
    ]);
  });

/** Attempt Email retention and delivery independently without widening the Email Worker's bindings. */
export const runEmailMaintenance = (
  environment: ForwardedEmailEnvironment
): Effect.Effect<void, EmailScheduleUnavailable> =>
  executeSchedule([
    activity("forwarded-email.sweep", sweepForwardedEmail(environment)),
    activity("forwarded-email.dispatch", dispatchForwardedEmail(environment)),
  ]).pipe(Effect.mapError(() => new EmailScheduleUnavailable()));
