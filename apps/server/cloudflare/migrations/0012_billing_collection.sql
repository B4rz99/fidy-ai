-- The arm and publication intent are created in the same D1 transaction as the BillingAttempt.
-- A sent arm is NEVER rearmed: an interrupted POST is ambiguous until verified evidence arrives.
CREATE TABLE billing_collection_arms (
  attempt_id TEXT PRIMARY KEY REFERENCES billing_attempts(id),
  state TEXT NOT NULL DEFAULT 'armed' CHECK (state IN ('armed', 'sent', 'rejected')),
  sent_at_ms INTEGER
) STRICT;
CREATE TABLE billing_collection_outbox (
  attempt_id TEXT PRIMARY KEY REFERENCES billing_attempts(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  last_attempt_at_ms INTEGER,
  published_at_ms INTEGER
) STRICT;
CREATE TRIGGER billing_attempt_arms_collection AFTER INSERT ON billing_attempts
BEGIN
  INSERT INTO billing_collection_arms (attempt_id) VALUES (NEW.id);
  INSERT INTO billing_collection_outbox (attempt_id) VALUES (NEW.id);
END;

-- Provider identifiers are observations, never authority. An id is globally bound to one attempt.
CREATE TABLE billing_transaction_evidence (
  transaction_id TEXT PRIMARY KEY NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')),
  first_observed_at_ms INTEGER NOT NULL,
  negative_observed_at_ms INTEGER,
  finalized_at_ms INTEGER,
  CHECK (status <> 'APPROVED' OR finalized_at_ms IS NOT NULL)
) STRICT;
CREATE INDEX billing_evidence_by_attempt ON billing_transaction_evidence(attempt_id);
-- A returned id can be looked up again after a transient GET failure. It does not authorize settlement.
CREATE TABLE billing_transaction_candidates (
  transaction_id TEXT PRIMARY KEY NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
  last_checked_at_ms INTEGER
) STRICT;
-- A signed callback can supply an id after a lost POST response. It is a bounded lookup hint only.
CREATE TABLE billing_event_candidates (
  transaction_id TEXT PRIMARY KEY NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 128),
  received_at_ms INTEGER NOT NULL,
  signed_at INTEGER NOT NULL DEFAULT 0,
  lookup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (lookup_attempts >= 0),
  last_checked_at_ms INTEGER,
  resolved_at_ms INTEGER
) STRICT;
CREATE TRIGGER billing_evidence_reject_foreign_id BEFORE INSERT ON billing_transaction_evidence
WHEN EXISTS (SELECT 1 FROM billing_transaction_evidence AS e
  WHERE e.transaction_id = NEW.transaction_id AND e.attempt_id <> NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'billing_evidence_foreign_transaction'); END;
CREATE TRIGGER billing_evidence_immutable_identity BEFORE UPDATE ON billing_transaction_evidence
WHEN NEW.transaction_id <> OLD.transaction_id OR NEW.attempt_id <> OLD.attempt_id
BEGIN SELECT RAISE(ABORT, 'billing_evidence_identity_immutable'); END;
CREATE TRIGGER billing_evidence_approval_monotonic BEFORE UPDATE ON billing_transaction_evidence
WHEN OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'billing_evidence_approval_immutable'); END;

-- Success can correct a previous negative, but no later event may revoke a verified approval.
DROP TRIGGER billing_attempt_terminal_monotonic;
CREATE TRIGGER billing_attempt_terminal_monotonic BEFORE UPDATE ON billing_attempts
WHEN (OLD.status = 'succeeded' AND NEW.status <> 'succeeded')
  OR (OLD.status = 'failed' AND NEW.status = 'pending')
BEGIN SELECT RAISE(ABORT, 'billing_attempt_terminal_immutable'); END;

CREATE TABLE billing_paid_periods (
  attempt_id TEXT PRIMARY KEY REFERENCES billing_attempts(id),
  starts_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL CHECK (ends_at_ms > starts_at_ms),
  renewal_anchor_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES billing_attempts(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  paid_period_ends_at_ms INTEGER NOT NULL,
  renewal_anchor_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE billing_audit (
  attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
  transition TEXT NOT NULL CHECK (transition IN ('succeeded', 'failed')),
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, transition)
) STRICT;
CREATE TABLE billing_followup_outbox (
  attempt_id TEXT PRIMARY KEY REFERENCES billing_attempts(id),
  kind TEXT NOT NULL CHECK (kind = 'renewal_due'),
  due_at_ms INTEGER NOT NULL
) STRICT;
