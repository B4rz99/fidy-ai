import type { ScheduledOperation } from "../contract";

const minuteMs = 60_000;

const cadenceMinutes: Partial<Record<ScheduledOperation, number>> = {
  "browserPairing.email.dispatch": 5,
  "browserPairing.email.reconcile": 5,
  "emailReplacement.dispatch": 5,
  "emailReplacement.reconcile": 5,
  "billing.renewal.dispatch": 15,
  "billing.cancellation.dispatch": 15,
  "billing.priceNotice.dispatch": 15,
  "dashboard.projectionRepair": 15,
  "billing.refund.reconcile": 5,
  "billing.refund.dispatch": 5,
  "billing.collection.dispatch": 5,
  "billing.collection.reconcile": 5,
  "consent.sweep": 60,
  "consent.proactivityOfferRetention": 60,
  "consent.disclosureRecovery": 5,
  "hostedTurn.whatsapp.dispatch": 5,
  "patPairing.sweep": 60,
  "ingestion.submissionRetention": 60,
  "ingestion.stagingSweep": 60,
  "ingestion.mediaRetention": 60,
  "ingestion.uploadAdmissionSweep": 60,
  "agent.workersAiAdmissionSweep": 60,
  "billing.cardPreparationAdmissionSweep": 60,
  "provider.authenticationRetention": 60,
  "canonical.admissionRetention": 60,
  "oauth.confirmationRetention": 60,
  "connections.attemptRetention": 60,
  "connections.grantCleanup": 5,
  "quota.consumptionRetention": 60,
  "ingestion.reviewEvidenceExpiry": 60,
  "ingestion.reviewDraftExpiry": 60,
  "ingestion.statementReconcile": 5,
  "ingestion.statementDispatch": 5,
  "audit.retention": 1_440,
  "recovery.retention": 1_440,
  "forwarded-email.sweep": 60,
  "forwarded-email.dispatch": 5,
};

export const activityDue = (
  input: Readonly<{ operation: ScheduledOperation; nowEpochMs: number }>
): boolean =>
  Math.floor(input.nowEpochMs / minuteMs) % (cadenceMinutes[input.operation] ?? 1) === 0;
