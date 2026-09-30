import type { OwnedStatement } from "~/shell/_shared/owned-statement";

/** Trusted subject columns in owner queries, or a bound explicit UserId. Never accept caller SQL. */
export type ConsentSubject =
  | "?"
  | "u.id"
  | "w.user_id"
  | "s.user_id"
  | "r.user_id"
  | "o.user_id"
  | "a.user_id"
  | "pats.user_id"
  | "pat_pairings.user_id"
  | "web_sessions.user_id"
  | "whatsapp_identities.user_id"
  | "transactions.user_id"
  | "forwarded_email_receipts.user_id";

/** Recheck revocation alongside protected work, not as a prior check-only authorization.
 * Use a bound UserId or the caller's already User-scoped relation. Compose the predicate into the
 * protected statement in the existing serialized D1 unit; this does not open a transaction.
 */
export const consentNotRevoked = (subject: ConsentSubject): string =>
  `NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ${subject})`;

/** Require the original stable-User grant at the instant protected work commits. */
export const consentGranted = (subject: ConsentSubject): string =>
  `EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = ${subject})`;

/** Revocation standing for refusal and retained-review classification, never an authorization. */
export const consentRevoked = (subject: ConsentSubject): string =>
  `EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ${subject})`;

/** Read-only refusal classification; protected work must still use the in-unit guard. */
export const consentRevocationQuery = (userId: string): OwnedStatement => ({
  sql: "SELECT 1 FROM consent_user_revocations WHERE user_id = ?",
  params: [userId],
});
