import { Schema } from "effect";
import type {
  EmailPendingWorkObservationInput,
  EmailRejectedWorkObservationInput,
  EmailWorkOperation,
} from "../contract";

const SampleSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));
const pendingQueries: Readonly<Record<EmailWorkOperation, string>> = {
  onboarding: `SELECT id, created_at_ms AS created, expires_at_ms AS deadline FROM pending_email_enrollments WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY created_at_ms LIMIT ?`,
  browserPairing: `SELECT work_id AS id, last_requested_at_ms AS created, expires_at_ms AS deadline FROM browser_pairing_email_proofs WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY last_requested_at_ms LIMIT ?`,
  emailReplacement: `SELECT work_id AS id, created_at_ms AS created, expires_at_ms AS deadline FROM email_replacements WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY created_at_ms LIMIT ?`,
};
const rejectedQueries: Readonly<Record<EmailWorkOperation, string>> = {
  onboarding:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM pending_email_enrollments WHERE state = 'rejected' AND created_at_ms >= ? LIMIT ?)",
  browserPairing:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM browser_pairing_email_proofs WHERE state = 'rejected' AND last_requested_at_ms >= ? LIMIT ?)",
  emailReplacement:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM email_replacements WHERE state = 'rejected' AND created_at_ms >= ? LIMIT ?)",
};

export const prepareEmailPendingWorkObservation = (
  input: EmailPendingWorkObservationInput
): D1PreparedStatement =>
  input.db
    .prepare(pendingQueries[input.operation])
    .bind(Schema.decodeSync(SampleSize)(input.limit));

export const prepareEmailRejectedWorkObservation = (
  input: EmailRejectedWorkObservationInput
): D1PreparedStatement =>
  input.db
    .prepare(rejectedQueries[input.operation])
    .bind(input.sinceMs, Schema.decodeSync(SampleSize)(input.limit));
