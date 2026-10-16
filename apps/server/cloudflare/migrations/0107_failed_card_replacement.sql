-- Preserve source identities and every child reference while allowing one active card.
-- Apply as one D1 transaction: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER card_source_requires_claim;
DROP TRIGGER card_source_immutable;
DROP TRIGGER payment_source_method_guard;
DROP TRIGGER payment_attempt_method_guard;
DROP TRIGGER refund_reservation_guard;
DROP TRIGGER weekly_price_notice;
DROP TRIGGER billing_attempt_requires_claim;
DROP TRIGGER subscription_cancellation_guard;
DROP TRIGGER billing_checkout_response_guard;
CREATE TABLE card_payment_sources_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES card_enrollments(id),
  wompi_source_id INTEGER NOT NULL UNIQUE CHECK (wompi_source_id > 0),
  billing_email TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms > 0),
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card', 'nequi', 'daviplata'))
) STRICT;

INSERT INTO card_payment_sources_next
(id,user_id,enrollment_id,wompi_source_id,billing_email,created_at_ms,method)
SELECT id,user_id,enrollment_id,wompi_source_id,billing_email,created_at_ms,method FROM card_payment_sources;
DROP TABLE card_payment_sources;
ALTER TABLE card_payment_sources_next RENAME TO card_payment_sources;
CREATE UNIQUE INDEX payment_source_active_user ON card_payment_sources(user_id) WHERE retired_at_ms IS NULL;
CREATE TRIGGER card_source_requires_claim BEFORE INSERT ON card_payment_sources
WHEN NOT EXISTS (
  SELECT 1 FROM card_enrollments AS e WHERE e.id = NEW.enrollment_id
    AND e.user_id = NEW.user_id AND e.status IN ('creating', 'verifying')
    AND e.payment_source_mode = 'create' AND e.billing_email = NEW.billing_email
    AND e.wompi_candidate_source_id = NEW.wompi_source_id
)
BEGIN SELECT RAISE(ABORT, 'card_source_invalid_claim'); END;
CREATE TRIGGER payment_source_method_guard BEFORE INSERT ON card_payment_sources
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = NEW.method
    AND (e.wompi_environment IS NOT NULL OR e.method = 'card'))
BEGIN SELECT RAISE(ABORT, 'payment_source_method_mismatch'); END;
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
CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN subscription_identities s ON s.user_id=a.user_id
  JOIN billing_transaction_evidence e ON e.attempt_id=a.id
  JOIN card_payment_sources p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND s.id=NEW.subscription_id
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > NEW.original_cents - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR EXISTS (SELECT 1 FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id
    AND original_cents<>NEW.original_cents)
BEGIN SELECT RAISE(IGNORE); END;
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
CREATE TRIGGER subscription_cancellation_guard BEFORE INSERT ON subscription_cancellations
WHEN NOT EXISTS (SELECT 1 FROM subscriptions sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN billing_paid_periods p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.user_id AND a.id=NEW.paid_attempt_id AND a.payment_source_id=NEW.payment_source_id
 AND NEW.paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN SELECT RAISE(ABORT, 'subscription_cancellation_invalid'); END;
CREATE TRIGGER billing_checkout_response_guard BEFORE INSERT ON billing_checkout_responses
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN billing_collection_arms arm ON arm.attempt_id=a.id
  JOIN billing_transaction_candidates candidate ON candidate.attempt_id=a.id
  JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.attempt_id AND candidate.transaction_id=NEW.transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'billing_checkout_response_invalid'); END;
CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_payment_sources
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.enrollment_id<>OLD.enrollment_id
  OR NEW.wompi_source_id<>OLD.wompi_source_id OR NEW.billing_email<>OLD.billing_email
  OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.method<>OLD.method
  OR OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL
  OR OLD.method<>'card'
  OR NOT EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id)
  OR EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.user_id=OLD.user_id)
  OR EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id
    AND (a.status<>'failed' OR NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=a.id)))
BEGIN SELECT RAISE(ABORT, 'card_source_immutable'); END;
CREATE TRIGGER card_source_retired_insert BEFORE INSERT ON card_payment_sources
WHEN NEW.retired_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'card_source_invalid_retirement'); END;
CREATE TRIGGER billing_attempt_retired_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM card_payment_sources source WHERE source.id=NEW.payment_source_id AND source.retired_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'billing_source_retired'); END;
PRAGMA defer_foreign_keys = OFF;

CREATE TRIGGER erasure_fence_card_payment_sources_insert BEFORE INSERT ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_payment_sources_update BEFORE UPDATE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_payment_sources_delete BEFORE DELETE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_card_payment_sources_delete BEFORE DELETE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_payment_sources','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'enrollment_id',OLD."enrollment_id",'wompi_source_id',OLD."wompi_source_id",'billing_email',OLD."billing_email",'created_at_ms',OLD."created_at_ms",'method',OLD."method",'retired_at_ms',OLD."retired_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
