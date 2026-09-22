-- A mailbox is collected only after authenticated, delivered, accepted pending Consent.
-- This is pre-User state: verification (#683) alone may create the stable User.
-- Rate-limit status messages before a stable User exists.
ALTER TABLE pending_consent_exchanges ADD COLUMN email_status_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (email_status_attempts BETWEEN 0 AND 5);
ALTER TABLE pending_consent_exchanges ADD COLUMN email_status_last_ms INTEGER;
-- A signed mailbox event first seen before acceptance cannot later be replayed into enrollment.
ALTER TABLE pending_consent_exchanges ADD COLUMN email_preaccept_latest_occurred_ms INTEGER;
CREATE TABLE pending_email_enrollments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  exchange_id TEXT NOT NULL UNIQUE REFERENCES pending_consent_exchanges(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL CHECK (length(email_address) BETWEEN 3 AND 254),
  submission_message_id TEXT NOT NULL CHECK (length(submission_message_id) BETWEEN 1 AND 256),
  submission_body_sha256 TEXT NOT NULL CHECK (length(submission_body_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous')),
  public_code TEXT,
  proof_digest BLOB,
  proof_expires_at_ms INTEGER,
  provider_message_id TEXT,
  wrong_proof_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_proof_attempts BETWEEN 0 AND 4),
  CHECK (expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 86400000),
  CHECK ((state = 'awaiting_proof' AND length(public_code) = 9 AND length(proof_digest) = 32 AND proof_expires_at_ms IS NOT NULL)
    OR (state <> 'awaiting_proof'))
) STRICT;
CREATE TABLE onboarding_email_outbox (
  id TEXT PRIMARY KEY NOT NULL REFERENCES pending_email_enrollments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version = 1),
  published_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER pending_email_requires_accepted_consent BEFORE INSERT ON pending_email_enrollments
WHEN NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e
  JOIN pending_consent_decisions AS d ON d.exchange_id = e.id
  WHERE e.id = NEW.exchange_id AND e.state = 'accepted' AND d.decision = 'accepted'
    AND NEW.created_at_ms < e.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'pending_email_requires_accepted_consent'); END;
CREATE TRIGGER pending_email_requires_outbox AFTER INSERT ON pending_email_enrollments
BEGIN
  INSERT INTO onboarding_email_outbox (id, version, created_at_ms)
  VALUES (NEW.id, 1, NEW.created_at_ms);
END;
