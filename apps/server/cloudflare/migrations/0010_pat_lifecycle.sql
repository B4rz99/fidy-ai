-- Complete PAT, Consent, and protected-work schema for the initial release.
-- Apply after 0009_transactions.sql: its audit table and original budget trigger must exist.
-- Ten-minute source admission retains only a keyed digest of the edge-observed visitor IP.
CREATE TABLE pat_pairing_admission (
  source_digest BLOB PRIMARY KEY NOT NULL CHECK (length(source_digest) = 32),
  window_start_ms INTEGER NOT NULL,
  started_count INTEGER NOT NULL CHECK (started_count BETWEEN 1 AND 20)
) STRICT;
CREATE INDEX pat_pairing_admission_expiry ON pat_pairing_admission(window_start_ms);
-- A short-lived private proof joins a public request only after a fresh WebSession reviews it.
CREATE TABLE pat_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  public_code TEXT NOT NULL UNIQUE,
  proof_digest BLOB NOT NULL CHECK (length(proof_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval','approved_awaiting_claim','claimed','expired_unapproved','revoked_unclaimed')),
  user_id TEXT REFERENCES users(id),
  approved_at_ms INTEGER,
  pat_expires_at_ms INTEGER,
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 32767),
  last_poll_at_ms INTEGER,
  minimum_poll_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_poll_seconds BETWEEN 5 AND 60),
  CHECK ((state = 'pending_approval' AND user_id IS NULL AND approved_at_ms IS NULL AND pat_expires_at_ms IS NULL) OR state <> 'pending_approval'),
  CHECK ((state IN ('approved_awaiting_claim','claimed') AND user_id IS NOT NULL AND approved_at_ms IS NOT NULL AND pat_expires_at_ms IS NOT NULL AND pat_expires_at_ms = approved_at_ms + lifetime_days * 86400000) OR state NOT IN ('approved_awaiting_claim','claimed'))
) STRICT;
CREATE INDEX pat_pairings_capacity ON pat_pairings(created_at_ms);
CREATE TABLE pats (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  short_id TEXT NOT NULL UNIQUE CHECK (length(short_id) = 8),
  bearer_digest BLOB NOT NULL CHECK (length(bearer_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  last_used_at_ms INTEGER,
  revoked_at_ms INTEGER,
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  request_id TEXT UNIQUE,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL)),
  CHECK (expires_at_ms <= created_at_ms + lifetime_days * 86400000)
) STRICT;
CREATE TRIGGER paired_pat_requires_claim BEFORE INSERT ON pats
WHEN NEW.pairing_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE id = NEW.pairing_id AND user_id = NEW.user_id
    AND state = 'claimed' AND expires_at_ms > NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT,'pat_pairing_not_claimable'); END;
CREATE INDEX pats_user_active ON pats(user_id,revoked_at_ms,expires_at_ms);
CREATE INDEX pats_user_issuance ON pats(user_id,issued_at_ms);
CREATE TABLE pat_grant_consents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  request_id TEXT UNIQUE,
  disclosure_revision TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL))
) STRICT;
CREATE TRIGGER pat_grant_consents_no_update BEFORE UPDATE ON pat_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER pat_grant_consents_no_delete BEFORE DELETE ON pat_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE pat_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT REFERENCES web_sessions(id),
  pat_id TEXT REFERENCES pats(id),
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER pat_audit_no_update BEFORE UPDATE ON pat_audit
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TRIGGER pat_audit_no_delete BEFORE DELETE ON pat_audit
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TABLE pat_review_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX pat_review_rate ON pat_review_attempts(session_id,occurred_at_ms);
CREATE INDEX pat_review_expiry ON pat_review_attempts(occurred_at_ms);
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
-- A User's explicit withdrawal of onboarding Consent is append-only and immediately blocks PAT work.
CREATE TABLE consent_user_revocations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  grant_record_id TEXT NOT NULL REFERENCES onboarding_consent_records(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_user_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM onboarding_consent_records AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;
CREATE TRIGGER consent_user_revocations_no_update BEFORE UPDATE ON consent_user_revocations
BEGIN SELECT RAISE(ABORT, 'consent_append_only'); END;
CREATE TRIGGER consent_user_revocations_no_delete BEFORE DELETE ON consent_user_revocations
BEGIN SELECT RAISE(ABORT, 'consent_append_only'); END;
-- Index PAT work by User and UTC day for the shared canonical budget.
CREATE INDEX pat_audit_by_user_day ON pat_audit(user_id, occurred_at_ms);
-- A one-row assertion forces D1 batch rollback when a guarded PAT lifecycle step
-- changes no row without throwing (for example, an ignored Consent evidence write).
CREATE TABLE pat_atomic_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
-- Category reads use the same durable User/day budget as browser and PAT Transaction work.
CREATE TABLE category_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation = 'categories.listCategories'),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX category_audit_by_user_day ON category_audit(user_id, occurred_at_ms);
CREATE TRIGGER category_audit_no_update BEFORE UPDATE ON category_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER category_audit_no_delete BEFORE DELETE ON category_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
-- A skipped guarded capture audit aborts the entire Transaction/SourceAttestation D1 batch.
CREATE TABLE transaction_capture_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
-- PAT metadata listing is canonical work; count it with Category and Transaction work per User/day.
DROP TRIGGER transaction_audit_daily_budget;
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs')
 AND (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
