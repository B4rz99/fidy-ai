-- Add shared authority to the existing physical tables. Their historical names remain
-- private storage details, so preceding Workers and retained collection work keep resolving them.
ALTER TABLE card_enrollments ADD COLUMN method TEXT NOT NULL DEFAULT 'card'
  CHECK (method IN ('card', 'nequi'));
ALTER TABLE card_payment_sources ADD COLUMN method TEXT NOT NULL DEFAULT 'card'
  CHECK (method IN ('card', 'nequi'));
-- New intents bind their provider environment before egress. NULL denotes only historical
-- card intent metadata; the new browser boundary never authorizes an unbound intent.
ALTER TABLE card_enrollments ADD COLUMN wompi_environment TEXT
  CHECK (wompi_environment IN ('sandbox', 'production'));
ALTER TABLE card_enrollments ADD COLUMN authorization_digest TEXT
  CHECK (authorization_digest IS NULL OR length(authorization_digest) = 64);
CREATE UNIQUE INDEX payment_authorization_once ON card_enrollments(authorization_digest)
  WHERE authorization_digest IS NOT NULL;
CREATE TRIGGER payment_enrollment_method_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.method <> OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment
  OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS NOT OLD.authorization_digest)
BEGIN SELECT RAISE(ABORT, 'payment_enrollment_method_immutable'); END;
CREATE TRIGGER payment_source_method_guard BEFORE INSERT ON card_payment_sources
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = NEW.method
    AND (e.wompi_environment IS NOT NULL OR e.method = 'card'))
BEGIN SELECT RAISE(ABORT, 'payment_source_method_mismatch'); END;
-- A source's provider environment derives from its immutable origin intent or, for
-- historical cards, retained BillingAttempt snapshots. Never reuse it across environments.
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
-- A failed live-credential/Consent check aborts the entire owner commit.
CREATE TABLE payment_commit_guards (
  enrollment_id TEXT PRIMARY KEY NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed = 1)
) STRICT;
