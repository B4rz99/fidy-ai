import { decidePATRevocation } from "~/core/consent/pat-revocation";
import {
  type FreshSessionSubject,
  freshSessionExists,
  freshSessionParams,
} from "~/shell/identity/session-guard";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";

// One fresh evidence id per row, including multi-grant revocation; no bearer enters a statement.
const randomConsentId = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
  || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-'
  || hex(randomblob(6)))`;

/** Append a User-origin revocation only for the live grant owned by this fresh WebSession. */
export const revokeOnePATConsent = (
  session: FreshSessionSubject,
  input: Readonly<{ id: string; shortId: string; current: number }>
): OwnedStatement => {
  const disclosure = decidePATRevocation("user-revoke-one");
  return {
    sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ?,g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND p.short_id = ? AND p.revoked_at_ms IS NULL AND p.expires_at_ms > ?
      AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
    params: [
      input.id,
      session.id,
      disclosure.revision,
      disclosure.text,
      input.current,
      session.user_id,
      input.shortId,
      input.current,
      ...freshSessionParams(session, input.current),
    ],
  };
};

/** Append one origin-qualified revocation per active PAT grant under the same User. */
export const revokeAllPATConsents = (
  session: FreshSessionSubject,
  current: number
): OwnedStatement => {
  const disclosure = decidePATRevocation("user-revoke-all");
  return {
    sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND p.revoked_at_ms IS NULL AND p.expires_at_ms > ?
      AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
    params: [
      session.id,
      disclosure.revision,
      disclosure.text,
      current,
      session.user_id,
      current,
      ...freshSessionParams(session, current),
    ],
  };
};

/** Include approved but unclaimed PATPairing grants in a User's revoke-all decision. */
export const revokeAllPairingConsents = (
  session: FreshSessionSubject,
  current: number
): OwnedStatement => {
  const disclosure = decidePATRevocation("user-revoke-unclaimed");
  return {
    sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM pat_pairings q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.user_id = ? AND q.state = 'approved_awaiting_claim'
      AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
    params: [
      session.id,
      disclosure.revision,
      disclosure.text,
      current,
      session.user_id,
      ...freshSessionParams(session, current),
    ],
  };
};

/** Scheduled expiry appends policy-origin evidence for approved unclaimed pairings. */
export const expirePairingConsents = (current: number, limit: number): OwnedStatement => {
  const disclosure = decidePATRevocation("approved-unclaimed-expiry");
  return {
    sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM pat_pairings q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.id IN (SELECT id FROM pat_pairings WHERE state = 'approved_awaiting_claim'
      AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
    params: [
      disclosure.policyReason,
      disclosure.revision,
      disclosure.text,
      current,
      current,
      limit,
    ],
  };
};

/** Scheduled expiry appends policy-origin evidence for every selected fixed-lifetime PAT. */
export const expirePATConsents = (current: number, limit: number): OwnedStatement => {
  const disclosure = decidePATRevocation("fixed-lifetime-expiry");
  return {
    sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.id IN (SELECT id FROM pats WHERE revoked_at_ms IS NULL
      AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
    params: [
      disclosure.policyReason,
      disclosure.revision,
      disclosure.text,
      current,
      current,
      limit,
    ],
  };
};

/** The User's reviewed manual grant, chained to its guarded PAT issuance in the same D1 unit. */
export const grantManualPATConsent = (
  session: FreshSessionSubject,
  input: Readonly<{ id: string; requestId: string; disclosure: string; current: number }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_grant_consents (id,user_id,session_id,request_id,disclosure_revision,disclosure_text,accepted_at_ms)
    SELECT ?,?,?,?,'pat-grant-2026-09',?,? WHERE changes() = 1`,
  params: [input.id, session.user_id, session.id, input.requestId, input.disclosure, input.current],
});

/** The User's reviewed pairing approval, chained to the guarded pairing transition. */
export const grantPairedPATConsent = (
  session: FreshSessionSubject,
  input: Readonly<{ id: string; pairingId: string; disclosure: string; current: number }>
): OwnedStatement => ({
  sql: `INSERT INTO pat_grant_consents (id,user_id,session_id,pairing_id,disclosure_revision,disclosure_text,accepted_at_ms)
    SELECT ?,?,?,?,'pat-pairing-grant-2026-09',?,? WHERE changes() = 1`,
  params: [input.id, session.user_id, session.id, input.pairingId, input.disclosure, input.current],
});
