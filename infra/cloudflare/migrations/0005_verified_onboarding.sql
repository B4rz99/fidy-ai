-- Stable state is born in one D1 batch only after the current mailbox proof is consumed.
CREATE UNIQUE INDEX onboarding_public_code ON pending_email_enrollments(public_code)
  WHERE public_code IS NOT NULL;
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  locale TEXT NOT NULL CHECK (locale = 'es-CO'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE whatsapp_identities (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  UNIQUE (portfolio_id, bsuid)
) STRICT;
CREATE TABLE verified_email_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  email_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  verified_at_ms INTEGER NOT NULL,
  CHECK (email_address = lower(trim(email_address)))
) STRICT;
CREATE TABLE onboarding_consent_records (
  id TEXT PRIMARY KEY NOT NULL REFERENCES pending_consent_exchanges(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  disclosure_json TEXT NOT NULL,
  disclosure_message_id TEXT NOT NULL,
  decision_message_id TEXT NOT NULL,
  decision_received_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE trial_periods (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  started_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  CHECK (ends_at_ms = started_at_ms + 604800000)
) STRICT;
CREATE TABLE backup_recovery_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  code_digest BLOB NOT NULL CHECK (length(code_digest) = 32),
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE completed_email_enrollments (
  enrollment_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_email_enrollments(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  completed_at_ms INTEGER NOT NULL
) STRICT;
-- A proof cannot be redeemed from an unrelated or superseded pending exchange.
CREATE TRIGGER onboarding_requires_current_proof BEFORE INSERT ON completed_email_enrollments
WHEN NOT EXISTS (
  SELECT 1 FROM pending_email_enrollments AS p
  JOIN pending_consent_exchanges AS e ON e.id = p.exchange_id
  JOIN pending_consent_decisions AS d ON d.exchange_id = e.id
  WHERE p.id = NEW.enrollment_id AND p.state = 'awaiting_proof'
    AND p.expires_at_ms > NEW.completed_at_ms AND p.proof_expires_at_ms > NEW.completed_at_ms
    AND e.state = 'accepted' AND e.expires_at_ms > NEW.completed_at_ms
    AND d.decision = 'accepted'
    AND EXISTS (SELECT 1 FROM onboarding_consent_records AS c
      WHERE c.id = e.id AND c.user_id = NEW.user_id)
    AND EXISTS (SELECT 1 FROM whatsapp_identities AS w
      WHERE w.user_id = NEW.user_id AND w.portfolio_id = e.portfolio_id AND w.bsuid = e.bsuid)
    AND EXISTS (SELECT 1 FROM verified_email_credentials AS v
      WHERE v.user_id = NEW.user_id AND v.email_address = p.email_address)
    AND EXISTS (SELECT 1 FROM trial_periods AS t
      WHERE t.user_id = NEW.user_id AND t.started_at_ms = NEW.completed_at_ms)
)
BEGIN SELECT RAISE(ABORT, 'onboarding_invalid_proof'); END;
CREATE TRIGGER onboarding_consume_proof AFTER INSERT ON completed_email_enrollments
BEGIN
  UPDATE pending_email_enrollments SET state = 'rejected', proof_digest = NULL,
    public_code = NULL, proof_expires_at_ms = NULL WHERE id = NEW.enrollment_id;
END;
