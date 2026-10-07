-- Retain refund stops and add a composed read-side fence for ordinary cancellation.
CREATE TABLE subscription_cancellations (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  paid_attempt_id TEXT NOT NULL REFERENCES billing_paid_periods(attempt_id),
  payment_source_id TEXT NOT NULL REFERENCES card_payment_sources(id),
  cancelled_at_ms INTEGER NOT NULL,
  paid_through_ms INTEGER NOT NULL,
  source_cancellation TEXT NOT NULL CHECK (source_cancellation IN ('detached','void-pending','voided')),
  void_started_at_ms INTEGER,
  void_verified_at_ms INTEGER,
  verification_count INTEGER NOT NULL DEFAULT 0 CHECK (verification_count BETWEEN 0 AND 8),
  last_offered_at_ms INTEGER
) STRICT;
CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM subscription_cancellations;
CREATE TRIGGER subscription_cancellation_guard BEFORE INSERT ON subscription_cancellations
WHEN NOT EXISTS (SELECT 1 FROM subscriptions sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN billing_paid_periods p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.user_id AND a.id=NEW.paid_attempt_id AND a.payment_source_id=NEW.payment_source_id
 AND NEW.paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN SELECT RAISE(ABORT, 'subscription_cancellation_invalid'); END;
CREATE TRIGGER subscription_cancellation_immutable BEFORE UPDATE ON subscription_cancellations
WHEN NEW.user_id<>OLD.user_id OR NEW.paid_attempt_id<>OLD.paid_attempt_id OR NEW.payment_source_id<>OLD.payment_source_id
 OR NEW.cancelled_at_ms<>OLD.cancelled_at_ms OR NEW.paid_through_ms<>OLD.paid_through_ms
 OR (OLD.source_cancellation IN ('detached','voided') AND NEW.source_cancellation<>OLD.source_cancellation)
 OR (OLD.void_started_at_ms IS NOT NULL AND NEW.void_started_at_ms IS NOT OLD.void_started_at_ms)
 OR (OLD.void_verified_at_ms IS NOT NULL AND NEW.void_verified_at_ms IS NOT OLD.void_verified_at_ms)
BEGIN SELECT RAISE(ABORT, 'subscription_cancellation_immutable'); END;
CREATE TRIGGER subscription_cancellation_no_delete BEFORE DELETE ON subscription_cancellations
BEGIN SELECT RAISE(ABORT, 'subscription_cancellation_immutable'); END;
CREATE TRIGGER subscription_cancellation_fence AFTER INSERT ON subscription_cancellations
BEGIN
  DELETE FROM billing_followup_outbox WHERE attempt_id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
  UPDATE billing_collection_arms SET state='rejected' WHERE state='armed'
    AND attempt_id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
END;
CREATE TRIGGER billing_attempt_detached_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM subscription_cancellations WHERE payment_source_id=NEW.payment_source_id)
BEGIN SELECT RAISE(ABORT, 'billing_source_detached'); END;
CREATE TRIGGER billing_followup_cancellation_stop BEFORE INSERT ON billing_followup_outbox
WHEN EXISTS (SELECT 1 FROM subscription_cancellations c JOIN billing_attempts a ON a.user_id=c.user_id WHERE a.id=NEW.attempt_id)
BEGIN SELECT RAISE(IGNORE); END;
