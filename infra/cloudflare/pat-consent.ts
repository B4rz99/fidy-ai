import { decidePATRevocation } from "@fidy/server/consent-pat";
import { type SessionRow, newId, sessionExists, sessionParams } from "./pat-shared";

// One RFC 4122 v4-shaped id per SELECT row; one bound id would duplicate on revoke-all.
const randomConsentId = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
  || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-'
  || hex(randomblob(6)))`;

/** Transaction-ready evidence; batch with its guarded PAT transition or commit neither. */
export const onePATRevocationEvidence = (
  db: D1Database,
  session: SessionRow,
  target: Readonly<{ shortId: string; current: number }>
): D1PreparedStatement => {
  const disclosure = decidePATRevocation("user-revoke-one");
  return db
    .prepare(`INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ?,g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND p.short_id = ? AND p.revoked_at_ms IS NULL AND p.expires_at_ms > ?
      AND ${sessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`)
    .bind(
      newId(),
      session.id,
      disclosure.revision,
      disclosure.text,
      target.current,
      session.user_id,
      target.shortId,
      target.current,
      ...sessionParams(session, target.current)
    );
};

/** Append exactly one User-origin record for every currently active grant under this User. */
export const allPATRevocationEvidence = (
  db: D1Database,
  session: SessionRow,
  current: number
): D1PreparedStatement => {
  const disclosure = decidePATRevocation("user-revoke-all");
  return db
    .prepare(`INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND p.revoked_at_ms IS NULL AND p.expires_at_ms > ?
      AND ${sessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`)
    .bind(
      session.id,
      disclosure.revision,
      disclosure.text,
      current,
      session.user_id,
      current,
      ...sessionParams(session, current)
    );
};

/** An approved but unclaimed User-owned grant is revocable before bearer delivery. */
export const allPairingRevocationEvidence = (
  db: D1Database,
  session: SessionRow,
  current: number
): D1PreparedStatement => {
  const disclosure = decidePATRevocation("user-revoke-unclaimed");
  return db
    .prepare(`INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM pat_pairings q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.user_id = ? AND q.state = 'approved_awaiting_claim'
      AND ${sessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`)
    .bind(
      session.id,
      disclosure.revision,
      disclosure.text,
      current,
      session.user_id,
      ...sessionParams(session, current)
    );
};

/** Automatic policy evidence for an approval whose one-time claim window expired. */
export const expiredPairingRevocationEvidence = (
  db: D1Database,
  current: number,
  limit: number
): D1PreparedStatement => {
  const disclosure = decidePATRevocation("approved-unclaimed-expiry");
  return db
    .prepare(`INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM pat_pairings q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.id IN (SELECT id FROM pat_pairings WHERE state = 'approved_awaiting_claim'
      AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`)
    .bind(disclosure.policyReason, disclosure.revision, disclosure.text, current, current, limit);
};

/** Automatic policy evidence for a PAT whose fixed lifetime elapsed without use-based renewal. */
export const expiredPATRevocationEvidence = (
  db: D1Database,
  current: number,
  limit: number
): D1PreparedStatement => {
  const disclosure = decidePATRevocation("fixed-lifetime-expiry");
  return db
    .prepare(`INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM pats p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.id IN (SELECT id FROM pats WHERE revoked_at_ms IS NULL
      AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`)
    .bind(disclosure.policyReason, disclosure.revision, disclosure.text, current, current, limit);
};
