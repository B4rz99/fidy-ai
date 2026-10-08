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
  id TEXT PRIMARY KEY NOT NULL,
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
