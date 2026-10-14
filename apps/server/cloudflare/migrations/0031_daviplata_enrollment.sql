-- D1 always enforces foreign_keys. Apply this entire file as one transaction;
-- defer validation while replacing the two parents (all retained child rows stay put).
-- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
PRAGMA defer_foreign_keys = ON;

-- These triggers belong to billing_attempts, but SQLite validates their references
-- during ALTER TABLE. Restore their exact guards after the original names exist again.
DROP TRIGGER billing_attempt_requires_claim;
DROP TRIGGER payment_attempt_method_guard;

CREATE TABLE card_enrollments_daviplata (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'creating', 'available', 'refused', 'expired', 'verifying')),
  payment_source_mode TEXT NOT NULL CHECK (payment_source_mode IN ('create', 'reuse')),
  contracts_json TEXT NOT NULL,
  disclosure_json TEXT NOT NULL,
  prepared_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = prepared_at_ms + 900000),
  accepted_at_ms INTEGER,
  payment_request_id TEXT CHECK (payment_request_id IS NULL OR length(payment_request_id) = 36),
  wompi_candidate_source_id INTEGER UNIQUE CHECK (wompi_candidate_source_id > 0),
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 8),
  last_verification_at_ms INTEGER,
  refusal_reason TEXT CHECK (refusal_reason IN ('provider-declined', 'provider-error', 'terms-changed')),
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card', 'nequi', 'daviplata')),
  wompi_environment TEXT CHECK (wompi_environment IN ('sandbox', 'production')),
  authorization_digest TEXT CHECK (authorization_digest IS NULL OR length(authorization_digest) = 64),
  CHECK ((status = 'prepared' AND payment_request_id IS NULL AND accepted_at_ms IS NULL)
    OR (status <> 'prepared'))
) STRICT;
INSERT INTO card_enrollments_daviplata (id, user_id, price_id, billing_email, status,
  payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
  accepted_at_ms, payment_request_id, wompi_candidate_source_id, verification_attempts,
  last_verification_at_ms, refusal_reason, method, wompi_environment, authorization_digest)
SELECT id, user_id, price_id, billing_email, status, payment_source_mode, contracts_json,
  disclosure_json, prepared_at_ms, expires_at_ms, accepted_at_ms, payment_request_id,
  wompi_candidate_source_id, verification_attempts, last_verification_at_ms, refusal_reason,
  method, wompi_environment, authorization_digest FROM card_enrollments;

CREATE TABLE card_payment_sources_daviplata (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES card_enrollments(id),
  wompi_source_id INTEGER NOT NULL UNIQUE CHECK (wompi_source_id > 0),
  billing_email TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card', 'nequi', 'daviplata'))
) STRICT;
INSERT INTO card_payment_sources_daviplata (id, user_id, enrollment_id, wompi_source_id,
  billing_email, created_at_ms, method)
SELECT id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms, method
FROM card_payment_sources;

-- Do not rename the original parents: that would rewrite retained child FK targets.
-- No parent FK has CASCADE/SET NULL/RESTRICT actions or DELETE triggers to run here.
DROP TABLE card_payment_sources;
DROP TABLE card_enrollments;
ALTER TABLE card_enrollments_daviplata RENAME TO card_enrollments;
ALTER TABLE card_payment_sources_daviplata RENAME TO card_payment_sources;

-- Restore all indexes and triggers owned by the rebuilt tables, unchanged from
-- 0009/0030. Other tables, views, triggers and foreign keys are not rebuilt.
CREATE UNIQUE INDEX card_enrollment_active_user ON card_enrollments(user_id)
WHERE status IN ('preparing', 'prepared', 'creating', 'verifying');
CREATE UNIQUE INDEX card_enrollment_request ON card_enrollments(user_id, payment_request_id)
WHERE payment_request_id IS NOT NULL;
CREATE UNIQUE INDEX payment_authorization_once ON card_enrollments(authorization_digest)
WHERE authorization_digest IS NOT NULL;
CREATE TRIGGER card_enrollment_preparation_limit BEFORE INSERT ON card_enrollments
WHEN (SELECT count(*) FROM card_enrollments WHERE user_id = NEW.user_id
  AND prepared_at_ms > NEW.prepared_at_ms - 3600000) >= 12
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER card_enrollment_evidence_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.user_id <> OLD.user_id OR NEW.price_id <> OLD.price_id
  OR ((OLD.status <> 'preparing' OR NEW.status <> 'prepared')
    AND (NEW.payment_source_mode <> OLD.payment_source_mode
      OR NEW.contracts_json <> OLD.contracts_json OR NEW.disclosure_json <> OLD.disclosure_json))
  OR NEW.prepared_at_ms <> OLD.prepared_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR (OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS NOT OLD.payment_request_id)
BEGIN SELECT RAISE(ABORT, 'card_enrollment_evidence_immutable'); END;
CREATE TRIGGER payment_enrollment_method_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.method <> OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment
  OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS NOT OLD.authorization_digest)
BEGIN SELECT RAISE(ABORT, 'payment_enrollment_method_immutable'); END;
CREATE TRIGGER card_source_requires_claim BEFORE INSERT ON card_payment_sources
WHEN NOT EXISTS (
  SELECT 1 FROM card_enrollments AS e WHERE e.id = NEW.enrollment_id
    AND e.user_id = NEW.user_id AND e.status IN ('creating', 'verifying')
    AND e.payment_source_mode = 'create' AND e.billing_email = NEW.billing_email
    AND e.wompi_candidate_source_id = NEW.wompi_source_id
)
BEGIN SELECT RAISE(ABORT, 'card_source_invalid_claim'); END;
CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_payment_sources
BEGIN SELECT RAISE(ABORT, 'card_source_immutable'); END;
CREATE TRIGGER payment_source_method_guard BEFORE INSERT ON card_payment_sources
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = NEW.method
    AND (e.wompi_environment IS NOT NULL OR e.method = 'card'))
BEGIN SELECT RAISE(ABORT, 'payment_source_method_mismatch'); END;
CREATE TRIGGER billing_attempt_requires_claim BEFORE INSERT ON billing_attempts
WHEN NEW.status <> 'pending' OR NEW.finalized_at_ms IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM card_enrollments AS e
  JOIN card_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN subscription_prices AS p ON p.id = e.price_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id
    AND e.status = 'available' AND e.payment_request_id = NEW.payment_request_id
    AND e.price_id = NEW.price_id
    AND NEW.amount = p.amount AND NEW.currency = p.currency
    AND NEW.billing_period = p.billing_period AND NEW.service_market = p.service_market
    AND NEW.tax_treatment = p.tax_treatment
)
BEGIN SELECT RAISE(ABORT, 'billing_attempt_invalid_claim'); END;
CREATE TRIGGER payment_attempt_method_guard BEFORE INSERT ON billing_attempts
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  JOIN card_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN card_enrollments AS origin ON origin.id = s.enrollment_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = s.method
    AND (e.wompi_environment = NEW.wompi_environment OR (e.wompi_environment IS NULL AND e.method = 'card'))
    AND (origin.wompi_environment = NEW.wompi_environment OR (origin.wompi_environment IS NULL AND origin.method = 'card'))
    AND NOT EXISTS (SELECT 1 FROM billing_attempts AS prior
      WHERE prior.payment_source_id = s.id AND prior.wompi_environment <> NEW.wompi_environment))
BEGIN SELECT RAISE(ABORT, 'payment_attempt_method_mismatch'); END;

PRAGMA defer_foreign_keys = OFF;
