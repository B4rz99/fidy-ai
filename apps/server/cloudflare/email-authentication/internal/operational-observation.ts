import { Schema } from "effect";
import type {
  EmailPendingWorkObservationInput,
  EmailRejectedWorkObservationInput,
  EmailWorkOperation,
} from "../contract";

const SampleSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));
const pendingQueries: Readonly<Record<EmailWorkOperation, string>> = {
  browserPairing: `SELECT work_id AS id, last_requested_at_ms AS created, expires_at_ms AS deadline FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY last_requested_at_ms LIMIT ?`,
  emailReplacement: `SELECT work_id AS id, created_at_ms AS created, expires_at_ms AS deadline FROM email_replacements WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY created_at_ms LIMIT ?`,
};
const rejectedQueries: Readonly<Record<EmailWorkOperation, string>> = {
  browserPairing:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE state = 'rejected' AND last_requested_at_ms >= ? LIMIT ?)",
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
