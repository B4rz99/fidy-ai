-- Weekly automatic renewal has its own origin; browser payment claims retain their existing guards.
ALTER TABLE billing_attempts ADD COLUMN previous_paid_attempt_id TEXT REFERENCES billing_paid_periods(attempt_id);
ALTER TABLE billing_attempts ADD COLUMN period_starts_at_ms INTEGER;
ALTER TABLE billing_attempts ADD COLUMN period_ends_at_ms INTEGER;
ALTER TABLE billing_attempts ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number = 1);
CREATE UNIQUE INDEX billing_weekly_renewal_identity ON billing_attempts(previous_paid_attempt_id)
WHERE previous_paid_attempt_id IS NOT NULL;
DROP TRIGGER billing_attempt_requires_claim;
CREATE TRIGGER billing_attempt_requires_claim BEFORE INSERT ON billing_attempts
WHEN NEW.status <> 'pending' OR NEW.finalized_at_ms IS NOT NULL
  OR NOT ((NEW.previous_paid_attempt_id IS NULL AND NEW.period_starts_at_ms IS NULL
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
  JOIN subscription_prices price ON price.id = NEW.price_id AND price.published_order = 1
  WHERE sub.user_id = NEW.user_id AND prior.id = NEW.previous_paid_attempt_id
    AND prior.status = 'succeeded' AND prior.billing_period = 'weekly' AND source.method = 'card'
    AND prior.payment_source_id = source.id AND prior.enrollment_id = NEW.enrollment_id
    AND prior.wompi_environment = NEW.wompi_environment AND prior.time_zone = NEW.time_zone
    AND NEW.attempt_number = 1 AND NEW.payment_request_id = NEW.id
    AND NEW.period_starts_at_ms = period.ends_at_ms AND NEW.period_ends_at_ms > NEW.period_starts_at_ms
    AND NEW.created_at_ms >= period.ends_at_ms
    AND price.billing_period = 'weekly' AND price.service_market = prior.service_market
    AND NEW.amount = price.amount AND NEW.currency = price.currency
    AND NEW.billing_period = price.billing_period AND NEW.service_market = price.service_market
    AND NEW.tax_treatment = price.tax_treatment
    AND NOT EXISTS (SELECT 1 FROM subscription_renewal_stops stop WHERE stop.user_id = sub.user_id)
)))
BEGIN SELECT RAISE(ABORT, 'billing_attempt_invalid_claim'); END;
CREATE TRIGGER billing_renewal_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.previous_paid_attempt_id IS NOT OLD.previous_paid_attempt_id
  OR NEW.period_starts_at_ms IS NOT OLD.period_starts_at_ms
  OR NEW.period_ends_at_ms IS NOT OLD.period_ends_at_ms OR NEW.attempt_number <> OLD.attempt_number
BEGIN SELECT RAISE(ABORT, 'billing_renewal_immutable'); END;
CREATE TRIGGER billing_renewal_period_guard BEFORE INSERT ON billing_paid_periods
WHEN EXISTS (SELECT 1 FROM billing_attempts a WHERE a.id = NEW.attempt_id
  AND a.previous_paid_attempt_id IS NOT NULL AND
    (NEW.starts_at_ms <> a.period_starts_at_ms OR NEW.ends_at_ms <> a.period_ends_at_ms
      OR NEW.renewal_anchor_ms <> a.period_ends_at_ms))
BEGIN SELECT RAISE(ABORT, 'billing_renewal_period_mismatch'); END;
-- Publishing a replacement changes only presentation selection, never immutable historical Price terms.
DROP TRIGGER subscription_prices_immutable;
CREATE TRIGGER subscription_prices_immutable BEFORE UPDATE ON subscription_prices
WHEN NEW.id <> OLD.id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
  OR NEW.billing_period <> OLD.billing_period OR NEW.service_market <> OLD.service_market
  OR NEW.tax_treatment <> OLD.tax_treatment OR NEW.terms_json <> OLD.terms_json
BEGIN SELECT RAISE(ABORT, 'price_immutable'); END;
CREATE TABLE billing_price_notices (
  user_id TEXT NOT NULL REFERENCES users(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  created_at_ms INTEGER NOT NULL,
  last_offered_at_ms INTEGER,
  send_started_at_ms INTEGER,
  accepted_at_ms INTEGER,
  PRIMARY KEY (user_id, price_id)
) STRICT;
CREATE TRIGGER weekly_price_notice AFTER UPDATE OF published_order ON subscription_prices
WHEN NEW.published_order = 1 AND OLD.published_order IS NULL
BEGIN
  INSERT OR IGNORE INTO billing_price_notices (user_id, price_id, created_at_ms)
    SELECT s.user_id, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM subscriptions s
    JOIN billing_attempts a ON a.id=s.attempt_id AND a.user_id=s.user_id
    JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=s.user_id
    WHERE a.billing_period='weekly' AND source.method='card' AND a.price_id<>NEW.id
      AND NOT EXISTS (SELECT 1 FROM subscription_renewal_stops stop WHERE stop.user_id=s.user_id);
END;
