-- Corrections are append-only history beside successful collection, never charge rewrites.
CREATE TABLE subscription_identities (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36)
) STRICT;
CREATE TRIGGER subscription_identity_immutable BEFORE UPDATE ON subscription_identities
BEGIN SELECT RAISE(ABORT, 'subscription_identity_immutable'); END;
CREATE TRIGGER subscription_identity_no_delete BEFORE DELETE ON subscription_identities
BEGIN SELECT RAISE(ABORT, 'subscription_identity_immutable'); END;

CREATE TABLE refund_attempts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT NOT NULL REFERENCES subscription_identities(id),
  billing_attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
  transaction_id TEXT NOT NULL REFERENCES billing_transaction_evidence(transaction_id),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  amount_in_cents INTEGER NOT NULL CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991),
  original_cents INTEGER NOT NULL CHECK (original_cents BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('refund','card-void')),
  operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  progress TEXT NOT NULL DEFAULT 'queued' CHECK (progress IN ('queued','verifying','outcome-unknown')),
  finalized_at_ms INTEGER,
  failure TEXT CHECK (failure IN ('provider-declined','provider-cancelled','provider-refused')),
  UNIQUE (user_id,request_id),
  CHECK ((status='pending' AND finalized_at_ms IS NULL AND failure IS NULL)
    OR (status='succeeded' AND finalized_at_ms IS NOT NULL AND failure IS NULL)
    OR (status='failed' AND finalized_at_ms IS NOT NULL AND failure IS NOT NULL))
) STRICT;
CREATE INDEX refunds_by_charge ON refund_attempts(billing_attempt_id,status);
CREATE INDEX refunds_by_user ON refund_attempts(user_id,created_at_ms);
-- D1, not a read-then-write calculation, serializes the reservation with all concurrent requests.
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
CREATE TRIGGER refund_acceptance_limit BEFORE INSERT ON refund_attempts
WHEN (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id AND status='pending')>=4
 OR (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id
   AND created_at_ms>NEW.created_at_ms-3600000)>=12
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.subscription_id<>OLD.subscription_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.snapshot_json<>OLD.snapshot_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents OR NEW.original_cents<>OLD.original_cents
 OR NEW.kind<>OLD.kind OR NEW.operator_id<>OLD.operator_id OR NEW.created_at_ms<>OLD.created_at_ms
 OR (OLD.status<>'pending' AND (NEW.status<>OLD.status OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms
   OR NEW.failure IS NOT OLD.failure OR NEW.progress<>OLD.progress))
BEGIN SELECT RAISE(ABORT, 'refund_history_immutable'); END;
CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund_attempts
BEGIN SELECT RAISE(ABORT, 'refund_history_immutable'); END;

CREATE TABLE refund_submission_claims (
  refund_id TEXT PRIMARY KEY REFERENCES refund_attempts(id),
  claimed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER refund_claim_requires_pending BEFORE INSERT ON refund_submission_claims
WHEN NOT EXISTS (SELECT 1 FROM refund_attempts WHERE id=NEW.refund_id AND status='pending')
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER refund_claim_immutable BEFORE UPDATE ON refund_submission_claims
BEGIN SELECT RAISE(ABORT, 'refund_claim_immutable'); END;
CREATE TRIGGER refund_claim_no_delete BEFORE DELETE ON refund_submission_claims
BEGIN SELECT RAISE(ABORT, 'refund_claim_immutable'); END;
CREATE TABLE refund_outbox (
  refund_id TEXT PRIMARY KEY REFERENCES refund_attempts(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version=1),
  last_attempt_at_ms INTEGER,
  published_at_ms INTEGER,
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 8),
  last_verification_at_ms INTEGER
) STRICT;
CREATE TRIGGER refund_creates_outbox AFTER INSERT ON refund_attempts
BEGIN INSERT INTO refund_outbox(refund_id) VALUES (NEW.id); END;

CREATE TABLE refund_outcome_evidence (
  refund_id TEXT PRIMARY KEY REFERENCES refund_attempts(id),
  provider_id TEXT UNIQUE CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 128),
  verified_status TEXT NOT NULL CHECK (verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED')),
  observed_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER refund_evidence_requires_claim BEFORE INSERT ON refund_outcome_evidence
WHEN NOT EXISTS (SELECT 1 FROM refund_attempts r JOIN refund_submission_claims c ON c.refund_id=r.id
  WHERE r.id=NEW.refund_id AND r.status='pending' AND NEW.observed_at_ms>=r.created_at_ms
    AND ((r.kind='refund' AND NEW.verified_status IN ('APPROVED','DECLINED','CANCELLED'))
      OR (r.kind='card-void' AND NEW.verified_status='VOIDED')))
BEGIN SELECT RAISE(ABORT, 'refund_evidence_invalid_claim'); END;
CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE ON refund_outcome_evidence
BEGIN SELECT RAISE(ABORT, 'refund_evidence_immutable'); END;
CREATE TRIGGER refund_evidence_no_delete BEFORE DELETE ON refund_outcome_evidence
BEGIN SELECT RAISE(ABORT, 'refund_evidence_immutable'); END;
-- Only this paid period loses access. Newer unrelated periods and independent TrialPeriods survive.
CREATE TABLE billing_access_adjustments (
  refund_id TEXT PRIMARY KEY REFERENCES refund_attempts(id),
  attempt_id TEXT NOT NULL REFERENCES billing_paid_periods(attempt_id),
  ends_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX billing_access_by_period ON billing_access_adjustments(attempt_id,ends_at_ms);
CREATE TABLE subscription_renewal_stops (
  refund_id TEXT PRIMARY KEY REFERENCES refund_attempts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  stopped_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER refund_verified_settlement AFTER INSERT ON refund_outcome_evidence
BEGIN
  UPDATE refund_attempts SET status=CASE WHEN NEW.verified_status IN ('APPROVED','VOIDED')
    THEN 'succeeded' ELSE 'failed' END, finalized_at_ms=NEW.observed_at_ms,
    failure=CASE NEW.verified_status WHEN 'DECLINED' THEN 'provider-declined'
      WHEN 'CANCELLED' THEN 'provider-cancelled' ELSE NULL END
    WHERE id=NEW.refund_id AND status='pending';
  INSERT OR IGNORE INTO billing_access_adjustments(refund_id,attempt_id,ends_at_ms)
    SELECT id,billing_attempt_id,NEW.observed_at_ms FROM refund_attempts
    WHERE id=NEW.refund_id AND status='succeeded';
  INSERT OR IGNORE INTO subscription_renewal_stops(refund_id,user_id,stopped_at_ms)
    SELECT id,user_id,NEW.observed_at_ms FROM refund_attempts
    WHERE id=NEW.refund_id AND status='succeeded';
  DELETE FROM billing_followup_outbox WHERE attempt_id IN
    (SELECT a.id FROM billing_attempts a JOIN refund_attempts r ON r.user_id=a.user_id
      WHERE r.id=NEW.refund_id AND r.status='succeeded');
END;
CREATE TRIGGER billing_access_adjustment_immutable BEFORE UPDATE ON billing_access_adjustments
BEGIN SELECT RAISE(ABORT, 'billing_access_adjustment_immutable'); END;
CREATE TRIGGER billing_access_adjustment_no_delete BEFORE DELETE ON billing_access_adjustments
BEGIN SELECT RAISE(ABORT, 'billing_access_adjustment_immutable'); END;
CREATE TRIGGER subscription_renewal_stop_immutable BEFORE UPDATE ON subscription_renewal_stops
BEGIN SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable'); END;
CREATE TRIGGER subscription_renewal_stop_no_delete BEFORE DELETE ON subscription_renewal_stops
BEGIN SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable'); END;
-- Late/replayed charge settlement must not resurrect an automatic renewal already stopped.
CREATE TRIGGER billing_followup_refund_stop BEFORE INSERT ON billing_followup_outbox
WHEN EXISTS (SELECT 1 FROM subscription_renewal_stops s JOIN billing_attempts a ON a.user_id=s.user_id
 WHERE a.id=NEW.attempt_id)
BEGIN SELECT RAISE(IGNORE); END;
