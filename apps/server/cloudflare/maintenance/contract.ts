import type { WeeklyDeliveryWork, WeeklyEnvironment } from "../insights/contract";
import { Data, type Effect, type Option } from "effect";
import type { PlatformMaintenanceInput } from "../runtime/contract";

/** Closed metadata for the published owner activities assembled by Maintenance. */
export type ScheduledOperation =
  | "async.health"
  | "audit.retention"
  | "canonical.admissionRetention"
  | "quota.consumptionRetention"
  | "operational.events.retention"
  | "operational.canary.publish"
  | "onboarding.email.dispatch"
  | "onboarding.email.reconcile"
  | "browserPairing.email.dispatch"
  | "browserPairing.email.reconcile"
  | "emailReplacement.dispatch"
  | "emailReplacement.reconcile"
  | "billing.refund.dispatch"
  | "billing.refund.reconcile"
  | "billing.collection.dispatch"
  | "billing.collection.reconcile"
  | "billing.cardPreparationAdmissionSweep"
  | "consent.sweep"
  | "consent.disclosureRecovery"
  | "hostedTurn.whatsapp.dispatch"
  | "hostedTurn.whatsapp.windowSweep"
  | "hostedTurn.sweep"
  | "patPairing.sweep"
  | "dashboard.projectionRepair"
  | "recurring.evaluate"
  | "insights.weekly.dispatch"
  | "ingestion.uploadAdmissionSweep"
  | "ingestion.mediaRetention"
  | "agent.workersAiAdmissionSweep"
  | "release.smoke.expiry"
  | "ingestion.reviewEvidenceExpiry"
  | "ingestion.submissionRetention"
  | "ingestion.stagingSweep"
  | "ingestion.statementReconcile"
  | "ingestion.statementDispatch"
  | "forwarded-email.sweep"
  | "forwarded-email.dispatch";

/** Already-bound owner work; the schedule supplies neither authorization nor retention policy. */
export type ScheduledActivity<E = void> = Readonly<{
  operation: ScheduledOperation;
  work: Effect.Effect<unknown, E>;
}>;

/** At least one independent activity failed; owner failures and payloads remain private. */
export class ScheduledWorkFailed extends Data.TaggedError("ScheduledWorkFailed") {}

/** A failed Email Worker tick retains its existing closed native failure classification. */
export class EmailScheduleUnavailable extends Data.TaggedError("EmailScheduleUnavailable") {}

/** Native Core bindings normalized once at the Worker boundary; no binding grants domain authority. */
export type CoreMaintenanceInput = Omit<
  PlatformMaintenanceInput,
  | "ONBOARDING_EMAIL_QUEUE"
  | "BROWSER_PAIRING_EMAIL_QUEUE"
  | "BILLING_COLLECTION_QUEUE"
  | "STATEMENT_EXTRACTION_QUEUE"
  | "HOSTED_WHATSAPP_QUEUE"
> &
  Readonly<{
    ONBOARDING_EMAIL_QUEUE: Option.Option<Queue>;
    BROWSER_PAIRING_EMAIL_QUEUE: Option.Option<Queue>;
    BILLING_COLLECTION_QUEUE: Option.Option<Queue>;
    STATEMENT_EXTRACTION_QUEUE: Option.Option<Queue>;
    HOSTED_WHATSAPP_QUEUE: Option.Option<Queue>;
  }> &
  WeeklyEnvironment &
  Partial<
    Readonly<{
      WEEKLY_DELIVERY_QUEUE: Queue<WeeklyDeliveryWork>;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<WeeklyDeliveryWork>;
    }>
  >;
