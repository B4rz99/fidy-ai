-- Immutable, symmetric Consent evidence for one formerly granted PAT or unclaimed approval.
-- The grant reference is unique: repeating a revoke or retrying a scheduled sweep cannot duplicate evidence.
CREATE TABLE pat_revocation_consents (
  id TEXT PRIMARY KEY NOT NULL,
  grant_consent_id TEXT NOT NULL UNIQUE REFERENCES pat_grant_consents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  pat_id TEXT UNIQUE REFERENCES pats(id),
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  session_id TEXT REFERENCES web_sessions(id),
  policy_reason TEXT CHECK (policy_reason IN ('pat-approved-unclaimed-expiry','pat-fixed-lifetime-expiry')),
  disclosure_revision TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  CHECK ((pat_id IS NULL) <> (pairing_id IS NULL)),
  CHECK ((session_id IS NULL) <> (policy_reason IS NULL))
) STRICT;
CREATE INDEX pat_revocation_consents_user ON pat_revocation_consents(user_id,occurred_at_ms);
CREATE TRIGGER pat_revocation_consents_no_update BEFORE UPDATE ON pat_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER pat_revocation_consents_no_delete BEFORE DELETE ON pat_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
