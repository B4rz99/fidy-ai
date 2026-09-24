-- Private, User-owned card enrollment state. No card fields or transient Wompi tokens are stored.
-- Price rows are immutable once published; a later change receives a new Price identity.
CREATE TABLE subscription_prices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'COP'),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  tax_treatment TEXT NOT NULL CHECK (tax_treatment = 'not-taxable'),
  terms_json TEXT NOT NULL,
  published_order INTEGER UNIQUE CHECK (published_order BETWEEN 1 AND 3)
) STRICT;
INSERT INTO subscription_prices (id, amount, currency, billing_period, service_market,
  tax_treatment, terms_json, published_order) VALUES
  ('22700000-0000-4000-8000-000000000001', '9900', 'COP', 'weekly', 'CO',
   'not-taxable', '{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}', 1),
  ('22700000-0000-4000-8000-000000000002', '28900', 'COP', 'monthly', 'CO',
   'not-taxable', '{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}', 2),
  ('22700000-0000-4000-8000-000000000003', '289900', 'COP', 'yearly', 'CO',
   'not-taxable', '{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}', 3);
CREATE TRIGGER subscription_prices_immutable BEFORE UPDATE ON subscription_prices
BEGIN SELECT RAISE(ABORT, 'price_immutable'); END;
CREATE TRIGGER subscription_prices_no_delete BEFORE DELETE ON subscription_prices
BEGIN SELECT RAISE(ABORT, 'price_immutable'); END;

CREATE TABLE card_enrollments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'creating', 'available', 'refused', 'expired', 'verifying')),
  payment_source_mode TEXT NOT NULL CHECK (payment_source_mode IN ('create', 'reuse')),
  -- Safe displayed evidence only; fresh provider acceptance tokens are never retained here.
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
  CHECK ((status = 'prepared' AND payment_request_id IS NULL AND accepted_at_ms IS NULL)
    OR (status <> 'prepared'))
) STRICT;
-- Only one claim can pass from prepared; retries must observe its existing state.
CREATE UNIQUE INDEX card_enrollment_active_user ON card_enrollments(user_id)
WHERE status IN ('preparing', 'prepared', 'creating', 'verifying');
-- The reservation and rate limit are both enforced at INSERT, including concurrent callers
-- and provider failures that never reach a ready enrollment.
CREATE TRIGGER card_enrollment_preparation_limit BEFORE INSERT ON card_enrollments
WHEN (SELECT count(*) FROM card_enrollments WHERE user_id = NEW.user_id
  AND prepared_at_ms > NEW.prepared_at_ms - 3600000) >= 12
BEGIN SELECT RAISE(IGNORE); END;
CREATE UNIQUE INDEX card_enrollment_request ON card_enrollments(user_id, payment_request_id)
WHERE payment_request_id IS NOT NULL;
CREATE TRIGGER card_enrollment_evidence_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.user_id <> OLD.user_id OR NEW.price_id <> OLD.price_id
  OR ((OLD.status <> 'preparing' OR NEW.status <> 'prepared')
    AND (NEW.payment_source_mode <> OLD.payment_source_mode
      OR NEW.contracts_json <> OLD.contracts_json OR NEW.disclosure_json <> OLD.disclosure_json))
  OR NEW.prepared_at_ms <> OLD.prepared_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR (OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS NOT OLD.payment_request_id)
BEGIN SELECT RAISE(ABORT, 'card_enrollment_evidence_immutable'); END;

CREATE TABLE card_payment_sources (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES card_enrollments(id),
  wompi_source_id INTEGER NOT NULL UNIQUE CHECK (wompi_source_id > 0),
  billing_email TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
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

-- Snapshot fields never change when the published Price or User context changes.
CREATE TABLE billing_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  enrollment_id TEXT NOT NULL REFERENCES card_enrollments(id),
  payment_request_id TEXT NOT NULL CHECK (length(payment_request_id) = 36),
  payment_source_id TEXT NOT NULL REFERENCES card_payment_sources(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'COP'),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  tax_treatment TEXT NOT NULL CHECK (tax_treatment = 'not-taxable'),
  time_zone TEXT NOT NULL,
  wompi_environment TEXT NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
  wompi_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  UNIQUE (user_id, payment_request_id)
) STRICT;
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
CREATE TRIGGER billing_attempt_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.user_id <> OLD.user_id OR NEW.enrollment_id <> OLD.enrollment_id
  OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.payment_source_id <> OLD.payment_source_id
  OR NEW.price_id <> OLD.price_id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
  OR NEW.billing_period <> OLD.billing_period OR NEW.service_market <> OLD.service_market
  OR NEW.tax_treatment <> OLD.tax_treatment OR NEW.time_zone <> OLD.time_zone
  OR NEW.wompi_environment <> OLD.wompi_environment OR NEW.wompi_reference <> OLD.wompi_reference
  OR NEW.created_at_ms <> OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'billing_attempt_snapshot_immutable'); END;
CREATE TRIGGER billing_attempt_terminal_monotonic BEFORE UPDATE ON billing_attempts
WHEN OLD.status <> 'pending' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'billing_attempt_terminal_immutable'); END;
