import { Data, type Effect, type Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { directoryName } from "../directory/contract";

export type ScheduledOperation =
  | "provider.authenticationRetention"
  | "recovery.retention"
  | "async.health"
  | "audit.retention"
  | "canonical.admissionRetention"
  | "oauth.confirmationRetention"
  | "connections.recovery"
  | "quota.consumptionRetention"
  | "operational.canary.publish"
  | "emailReplacement.dispatch"
  | "emailReplacement.reconcile"
  | "billing.refund.dispatch"
  | "billing.refund.reconcile"
  | "billing.cancellation.dispatch"
  | "consent.sweep"
  | "consent.proactivityOfferRetention"
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
  | "agent.openAiAdmissionSweep"
  | "ingestion.reviewDraftExpiry"
  | "ingestion.reviewEvidenceExpiry"
  | "ingestion.submissionRetention"
  | "ingestion.stagingSweep"
  | "ingestion.statementReconcile"
  | "ingestion.statementDispatch"
  | "forwarded-email.sweep"
  | "forwarded-email.dispatch";

export type ScheduledActivity<E = void> = Readonly<{
  operation: ScheduledOperation;
  work: Effect.Effect<unknown, E>;
}>;

export class ScheduledWorkFailed extends Data.TaggedError("ScheduledWorkFailed")<{
  readonly cause: Option.Option<unknown>;
}> {}

export class EmailScheduleUnavailable extends Data.TaggedError("EmailScheduleUnavailable") {}

export const maintenanceName = "core-maintenance-v1";

export const registrationAcceptedStatus = 204;

export const registerLifetimeUrl = "https://maintenance.invalid/lifetime/register";

export const fenceLifetimeUrl = "https://maintenance.invalid/lifetime/fence";

export const retireLifetimeUrl = "https://maintenance.invalid/lifetime/retire";

export class UserRegistrationUnavailable extends Data.TaggedError("UserRegistrationUnavailable") {}

export const watchdogUrl = "https://maintenance.invalid/watchdog";

export const RecoveryOwner = Schema.Union([UserId, Schema.Literal(directoryName)]);

export const reserveRecoveryUrl = "https://maintenance.invalid/recovery/reserve";

export const settleRecoveryUrl = "https://maintenance.invalid/recovery/settle";

export const recoveryGraceMs = 120_000;

export const recoveryOwnerHeader = "fidy-recovery-owner";

export const recoveryGenerationHeader = "fidy-recovery-generation";

export const recoveryAlarmHeader = "fidy-next-recovery-alarm";

export const ownerCheckUrl = "https://owner.internal/work/check";

const privateCheckRequest =
  (url: string) =>
  (request: Request): boolean =>
    request.url === url &&
    request.method === "POST" &&
    (request.body === null || request.headers.get("content-length") === "0");

export const completedCheckStatus = 204;

export const ownerCheckResponse = (repaired = false): Response =>
  new Response(null, {
    status: completedCheckStatus,
    headers: { "fidy-alarm-repaired": repaired ? "1" : "0" },
  });

export const idleRecoveryResponse = (): Response => {
  const response = ownerCheckResponse();
  response.headers.set(recoveryAlarmHeader, "idle");

  return response;
};

export const ownerCheckRequest = privateCheckRequest(ownerCheckUrl);

export const watchdogRequest = privateCheckRequest(watchdogUrl);

export const expireLifetimeUrl = "https://maintenance.invalid/lifetime/expire";
