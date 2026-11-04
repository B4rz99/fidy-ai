import type {
  EmailPendingWorkObservationInput,
  EmailProofRequest,
  EmailProofStart,
  EmailRejectedWorkObservationInput,
  VerifiedEmailQueryInput,
} from "./contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

import {
  prepareEmailPendingWorkObservation as pendingWork,
  prepareEmailRejectedWorkObservation as rejectedWork,
} from "./internal/operational-observation";

import {
  completeBrowserPairingEmail as completePairing,
  startBrowserPairingEmail as startPairing,
} from "./internal/browser-pairing-email";
import {
  completeEmailReplacement as completeReplacement,
  requestEmailReplacement as requestReplacement,
} from "./internal/email-replacement";

/** Request a bounded mailbox proof only after the browser proves its pending pairing; responses do not enumerate Users. */
export const startBrowserPairingEmail = (input: EmailProofStart): Promise<Response> =>
  startPairing(input);
/** Approve only the same pairing for the proved mailbox's existing User; no session is created. */
export const completeBrowserPairingEmail = (input: EmailProofRequest): Promise<Response> =>
  completePairing(input);
/** Begin a candidate-mailbox proof under current fresh WebSession authority; collisions stay non-enumerating. */
export const requestEmailReplacement = (input: EmailProofStart): Promise<Response> =>
  requestReplacement(input);
/** Verify the candidate before atomically replacing the User's sole credential; stale, foreign and replayed proofs fail closed. */
export const completeEmailReplacement = (input: EmailProofRequest): Promise<Response> =>
  completeReplacement(input);

/**
 * Project only userId and emailAddress for the exact User inside the caller's guarded D1 statement.
 * Possession of a UserId grants no authority: compose the live credential and purpose guards in
 * the same statement before releasing the mailbox. This query is not a reusable authorization.
 */
export const verifiedEmailQuery = ({ userId }: VerifiedEmailQueryInput): OwnedStatement => ({
  sql: "SELECT user_id AS userId, address AS emailAddress FROM verified_email_credentials WHERE user_id = ?",
  params: [userId],
});
/** Observe at most eight pending work identities and deadlines; no User, mailbox or proof is released. */
export const prepareEmailPendingWorkObservation = (
  input: EmailPendingWorkObservationInput
): D1PreparedStatement => pendingWork(input);
/** Count a bounded recent rejection sample without exposing provider or proof evidence. */
export const prepareEmailRejectedWorkObservation = (
  input: EmailRejectedWorkObservationInput
): D1PreparedStatement => rejectedWork(input);

/** Observe every retained source intent without expiry, Consent, sampling, or feature filters.
 * Disposition 3 retains an immutable provider identity or a User-waiting state; it never authorizes a fresh send. */
export const prepareRecoveryDrain = (db: D1Database): D1PreparedStatement =>
  db.prepare(`SELECT coalesce(sum(disposition=1),0) AS pending,
    coalesce(sum(disposition=2),0) AS ambiguous,
    coalesce(sum(disposition=3),0) AS preservedBlocked FROM (
SELECT CASE WHEN email_state='awaiting_delivery' THEN 1 WHEN email_state IN('sending','ambiguous') THEN 2 WHEN email_state='awaiting_proof' THEN 3 WHEN email_state IN('approved','rejected') THEN 0 ELSE 2 END AS disposition FROM browser_login_pairings WHERE email_work_id IS NOT NULL
UNION ALL SELECT CASE WHEN state='awaiting_delivery' THEN 1 WHEN state IN('sending','ambiguous') THEN 2 WHEN state='awaiting_proof' THEN 3 WHEN state='rejected' THEN 0 ELSE 2 END FROM email_replacements
  )`);
