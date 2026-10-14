-- Keep the original single-attempt column and add a bounded renewal ordinal.
-- Existing identities, financial terms, provider evidence, and periods remain untouched.
DROP TRIGGER billing_attempt_requires_claim;
DROP TRIGGER billing_renewal_snapshot_immutable;
DROP INDEX billing_weekly_renewal_identity;
ALTER TABLE billing_attempts ADD COLUMN renewal_attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (renewal_attempt_number BETWEEN 1 AND 3);
CREATE UNIQUE INDEX billing_renewal_identity ON billing_attempts(previous_paid_attempt_id, renewal_attempt_number)
WHERE previous_paid_attempt_id IS NOT NULL;
CREATE TRIGGER billing_attempt_requires_claim BEFORE INSERT ON billing_attempts
WHEN NEW.status <> 'pending' OR NEW.finalized_at_ms IS NOT NULL
  OR NOT ((NEW.renewal_attempt_number = 1 AND NEW.previous_paid_attempt_id IS NULL AND NEW.calendar_anchor_ms IS NULL AND NEW.period_starts_at_ms IS NULL
    AND NEW.period_ends_at_ms IS NULL AND EXISTS (
  SELECT 1 FROM card_enrollments AS e
  JOIN card_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN subscription_prices AS p ON p.id = e.price_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id
    AND e.status = 'available' AND e.payment_request_id = NEW.payment_request_id
    AND e.price_id = NEW.price_id
    AND NEW.amount = p.amount AND NEW.currency = p.currency
    AND NEW.billing_period = p.billing_period AND NEW.service_market = p.service_market
    AND NEW.tax_treatment = p.tax_treatment
))
    OR (NEW.previous_paid_attempt_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM subscriptions sub
  JOIN billing_attempts prior ON prior.id = sub.attempt_id AND prior.user_id = sub.user_id
  JOIN billing_paid_periods period ON period.attempt_id = prior.id
  JOIN card_payment_sources source ON source.id = NEW.payment_source_id AND source.user_id = sub.user_id
  JOIN subscription_prices price ON price.id = NEW.price_id AND price.published_order IS NOT NULL
  WHERE sub.user_id = NEW.user_id AND prior.id = NEW.previous_paid_attempt_id
    AND prior.status = 'succeeded'
    AND prior.payment_source_id = source.id AND prior.enrollment_id = NEW.enrollment_id
    AND prior.wompi_environment = NEW.wompi_environment AND prior.time_zone = NEW.time_zone
    AND NEW.renewal_attempt_number = 1 AND NEW.payment_request_id = NEW.id
    AND NEW.period_starts_at_ms = period.ends_at_ms AND NEW.period_ends_at_ms > NEW.period_starts_at_ms
    AND NEW.created_at_ms >= period.ends_at_ms
    AND NEW.calendar_anchor_ms = COALESCE(prior.calendar_anchor_ms, period.starts_at_ms)
    AND price.billing_period = prior.billing_period AND price.service_market = prior.service_market
    AND NEW.amount = price.amount AND NEW.currency = price.currency
    AND NEW.billing_period = price.billing_period AND NEW.service_market = price.service_market
    AND NEW.tax_treatment = price.tax_treatment
    AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
))
    OR (NEW.renewal_attempt_number BETWEEN 2 AND 3 AND EXISTS (
      SELECT 1 FROM billing_attempts first
      JOIN billing_attempts last ON last.previous_paid_attempt_id = first.previous_paid_attempt_id
      JOIN subscriptions sub ON sub.attempt_id = first.previous_paid_attempt_id AND sub.user_id = first.user_id
      WHERE first.renewal_attempt_number = 1 AND first.previous_paid_attempt_id = NEW.previous_paid_attempt_id
        AND first.user_id = NEW.user_id AND last.renewal_attempt_number = NEW.renewal_attempt_number - 1
        AND last.status = 'failed' AND first.enrollment_id = NEW.enrollment_id
        AND first.payment_source_id = NEW.payment_source_id AND first.price_id = NEW.price_id
        AND first.amount = NEW.amount AND first.currency = NEW.currency
        AND first.billing_period = NEW.billing_period AND first.service_market = NEW.service_market
        AND first.tax_treatment = NEW.tax_treatment AND first.time_zone = NEW.time_zone
        AND first.wompi_environment = NEW.wompi_environment AND NEW.payment_request_id = NEW.id
        AND first.calendar_anchor_ms = NEW.calendar_anchor_ms
        AND first.period_starts_at_ms = NEW.period_starts_at_ms AND first.period_ends_at_ms = NEW.period_ends_at_ms
        AND NEW.created_at_ms >= first.period_starts_at_ms + (NEW.renewal_attempt_number - 1) * 86400000
        AND NEW.created_at_ms < first.period_starts_at_ms + 259200000
        AND NOT EXISTS (SELECT 1 FROM billing_attempts sibling WHERE sibling.previous_paid_attempt_id = first.previous_paid_attempt_id
          AND (sibling.status <> 'failed' OR sibling.renewal_attempt_number >= NEW.renewal_attempt_number))
        AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
    )))
BEGIN SELECT RAISE(ABORT, 'billing_attempt_invalid_claim'); END;

CREATE TRIGGER billing_renewal_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.previous_paid_attempt_id IS NOT OLD.previous_paid_attempt_id
  OR NEW.period_starts_at_ms IS NOT OLD.period_starts_at_ms
  OR NEW.attempt_number <> OLD.attempt_number
  OR NEW.period_ends_at_ms IS NOT OLD.period_ends_at_ms OR NEW.renewal_attempt_number <> OLD.renewal_attempt_number
BEGIN SELECT RAISE(ABORT, 'billing_renewal_immutable'); END;
-- A late approval is retained as success but cannot grant the same renewal period twice.
CREATE TRIGGER billing_renewal_period_once BEFORE INSERT ON billing_paid_periods
WHEN EXISTS (SELECT 1 FROM billing_attempts a JOIN billing_attempts sibling
  ON sibling.previous_paid_attempt_id = a.previous_paid_attempt_id
  JOIN billing_paid_periods paid ON paid.attempt_id = sibling.id
  WHERE a.id = NEW.attempt_id AND a.previous_paid_attempt_id IS NOT NULL)
BEGIN SELECT RAISE(IGNORE); END;
-- Definitive renewal failures permit a new attempt; initial checkout uncertainty still needs support evidence.
DROP TRIGGER billing_attempt_user_collection_guard;
CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempts AS prior
  WHERE prior.user_id = NEW.user_id
    AND (prior.status = 'pending' OR (prior.status = 'failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations AS clear WHERE clear.attempt_id = prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_collection_arms stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempts success
        JOIN billing_paid_periods paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN SELECT RAISE(ABORT, 'billing_user_collection_unresolved'); END;

CREATE TRIGGER billing_renewal_success_fence AFTER INSERT ON billing_paid_periods
BEGIN
  UPDATE billing_collection_arms SET state='rejected' WHERE state='armed' AND attempt_id<>NEW.attempt_id
    AND attempt_id IN (SELECT sibling.id FROM billing_attempts sibling JOIN billing_attempts success
      ON success.previous_paid_attempt_id=sibling.previous_paid_attempt_id WHERE success.id=NEW.attempt_id
      AND success.previous_paid_attempt_id IS NOT NULL);
END;
