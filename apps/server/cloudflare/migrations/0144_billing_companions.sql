PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS billing_attempt_snapshot_immutable;

DROP TRIGGER IF EXISTS billing_no_charge_immutable_update;

DROP TRIGGER IF EXISTS billing_evidence_reject_foreign_id;

DROP TRIGGER IF EXISTS billing_evidence_immutable_identity;

DROP TRIGGER IF EXISTS billing_evidence_approval_monotonic;

DROP TRIGGER IF EXISTS billing_attempt_terminal_monotonic;

DROP TRIGGER IF EXISTS billing_paid_period_immutable_update;

DROP TRIGGER IF EXISTS refund_acceptance_limit;

DROP TRIGGER IF EXISTS refund_snapshot_immutable;

DROP TRIGGER IF EXISTS refund_claim_requires_pending;

DROP TRIGGER IF EXISTS refund_claim_immutable;

DROP TRIGGER IF EXISTS refund_creates_outbox;

DROP TRIGGER IF EXISTS refund_evidence_requires_claim;

DROP TRIGGER IF EXISTS refund_evidence_immutable;

DROP TRIGGER IF EXISTS refund_verified_settlement;

DROP TRIGGER IF EXISTS billing_access_adjustment_immutable;

DROP TRIGGER IF EXISTS subscription_renewal_stop_immutable;

DROP TRIGGER IF EXISTS billing_followup_refund_stop;

DROP TRIGGER IF EXISTS billing_renewal_period_guard;

DROP TRIGGER IF EXISTS billing_calendar_anchor_immutable;

DROP TRIGGER IF EXISTS billing_renewal_snapshot_immutable;

DROP TRIGGER IF EXISTS billing_renewal_period_once;

DROP TRIGGER IF EXISTS subscription_cancellation_immutable;

DROP TRIGGER IF EXISTS billing_attempt_detached_source;

DROP TRIGGER IF EXISTS billing_followup_cancellation_stop;

DROP TRIGGER IF EXISTS billing_no_charge_immutable_delete;

DROP TRIGGER IF EXISTS billing_paid_period_immutable_delete;

DROP TRIGGER IF EXISTS refund_no_delete;

DROP TRIGGER IF EXISTS refund_claim_no_delete;

DROP TRIGGER IF EXISTS refund_evidence_no_delete;

DROP TRIGGER IF EXISTS billing_access_adjustment_no_delete;

DROP TRIGGER IF EXISTS subscription_renewal_stop_no_delete;

DROP TRIGGER IF EXISTS subscription_cancellation_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_attempts_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_attempts_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_attempts_delete;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_insert;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_update;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_delete;

DROP TRIGGER IF EXISTS erasure_fence_subscription_cancellations_insert;

DROP TRIGGER IF EXISTS erasure_fence_subscription_cancellations_update;

DROP TRIGGER IF EXISTS erasure_fence_subscription_cancellations_delete;

DROP TRIGGER IF EXISTS erasure_fence_subscription_renewal_stops_insert;

DROP TRIGGER IF EXISTS erasure_fence_subscription_renewal_stops_update;

DROP TRIGGER IF EXISTS erasure_fence_subscription_renewal_stops_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_event_candidates_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_event_candidates_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_event_candidates_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_access_adjustments_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_access_adjustments_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_access_adjustments_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_followup_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_followup_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_followup_outbox_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_no_charge_confirmations_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_no_charge_confirmations_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_no_charge_confirmations_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_paid_periods_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_paid_periods_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_paid_periods_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_recovery_reviews_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_recovery_reviews_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_recovery_reviews_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_candidates_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_candidates_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_candidates_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_evidence_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_evidence_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_transaction_evidence_delete;

DROP TRIGGER IF EXISTS erasure_fence_refund_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_refund_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_refund_outbox_delete;

DROP TRIGGER IF EXISTS erasure_fence_refund_outcome_evidence_insert;

DROP TRIGGER IF EXISTS erasure_fence_refund_outcome_evidence_update;

DROP TRIGGER IF EXISTS erasure_fence_refund_outcome_evidence_delete;

DROP TRIGGER IF EXISTS erasure_fence_refund_submission_claims_insert;

DROP TRIGGER IF EXISTS erasure_fence_refund_submission_claims_update;

DROP TRIGGER IF EXISTS erasure_fence_refund_submission_claims_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_access_adjustments_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_event_candidates_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_followup_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_no_charge_confirmations_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_recovery_reviews_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_transaction_candidates_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_transaction_evidence_delete;

DROP TRIGGER IF EXISTS erasure_preserve_refund_attempts_delete;

DROP TRIGGER IF EXISTS erasure_preserve_refund_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_refund_outcome_evidence_delete;

DROP TRIGGER IF EXISTS erasure_preserve_refund_submission_claims_delete;

DROP TRIGGER IF EXISTS erasure_preserve_subscription_cancellations_delete;

DROP TRIGGER IF EXISTS erasure_preserve_subscription_renewal_stops_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_attempts_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_paid_periods_delete;

DROP TRIGGER IF EXISTS billing_checkout_response_no_update;

DROP TRIGGER IF EXISTS billing_checkout_response_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_checkout_responses_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_checkout_responses_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_checkout_responses_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_checkout_responses_delete;

DROP TRIGGER IF EXISTS payment_attempt_method_guard;

DROP TRIGGER IF EXISTS refund_reservation_guard;

DROP TRIGGER IF EXISTS weekly_price_notice;

DROP TRIGGER IF EXISTS billing_attempt_requires_claim;

DROP TRIGGER IF EXISTS subscription_cancellation_guard;

DROP TRIGGER IF EXISTS card_source_immutable;

DROP TRIGGER IF EXISTS billing_attempt_retired_source;

DROP TRIGGER IF EXISTS billing_attempt_arms_collection;

DROP TRIGGER IF EXISTS billing_no_charge_requires_sent_arm;

DROP TRIGGER IF EXISTS billing_renewal_success_fence;

DROP TRIGGER IF EXISTS subscription_cancellation_fence;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_work_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_work_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_work_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_collection_work_delete;

DROP TRIGGER IF EXISTS billing_attempt_user_collection_guard;

DROP TRIGGER IF EXISTS billing_checkout_response_guard;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_insert;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_update;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_delete;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_billing_transition;

DROP VIEW IF EXISTS subscription_renewal_fences;

DROP VIEW IF EXISTS billing_retry_clearances;

CREATE TABLE billing_provider_transactions (
 transaction_id TEXT PRIMARY KEY NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 128),
 attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
 lookup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(lookup_attempts>=0),last_checked_at_ms INTEGER,
 status TEXT CHECK(status IN ('PENDING','APPROVED','DECLINED','VOIDED','ERROR')),
 first_observed_at_ms INTEGER,negative_observed_at_ms INTEGER,finalized_at_ms INTEGER,
 evidence_transaction_id TEXT GENERATED ALWAYS AS(CASE WHEN status IS NOT NULL THEN transaction_id END) VIRTUAL UNIQUE,
 CHECK((status IS NULL AND first_observed_at_ms IS NULL AND negative_observed_at_ms IS NULL AND finalized_at_ms IS NULL)
  OR (status IS NOT NULL AND first_observed_at_ms IS NOT NULL AND (status<>'APPROVED' OR finalized_at_ms IS NOT NULL)))
) STRICT;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_billing_identity',NOT EXISTS(SELECT 1 FROM billing_transaction_candidates c JOIN billing_transaction_evidence e USING(transaction_id) WHERE c.attempt_id<>e.attempt_id);

INSERT INTO billing_provider_transactions(transaction_id,attempt_id,lookup_attempts,last_checked_at_ms,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms)
 SELECT ids.transaction_id,coalesce(c.attempt_id,e.attempt_id),coalesce(c.lookup_attempts,0),c.last_checked_at_ms,e.status,e.first_observed_at_ms,e.negative_observed_at_ms,e.finalized_at_ms
 FROM (SELECT transaction_id FROM billing_transaction_candidates UNION SELECT transaction_id FROM billing_transaction_evidence) ids
 LEFT JOIN billing_transaction_candidates c USING(transaction_id) LEFT JOIN billing_transaction_evidence e USING(transaction_id);

CREATE TABLE billing_attempts_consolidated (
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
previous_paid_attempt_id TEXT REFERENCES billing_attempts_consolidated(paid_attempt_id),
period_starts_at_ms INTEGER,
period_ends_at_ms INTEGER,
attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number = 1),
calendar_anchor_ms INTEGER,
renewal_attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (renewal_attempt_number BETWEEN 1 AND 3),
paid_starts_at_ms INTEGER,
paid_ends_at_ms INTEGER,
paid_renewal_anchor_ms INTEGER,
checkout_transaction_id TEXT UNIQUE REFERENCES billing_provider_transactions(transaction_id),
collection_state TEXT DEFAULT 'armed',
collection_sent_at_ms INTEGER,
collection_last_attempt_at_ms INTEGER,
followup_kind TEXT,
followup_due_at_ms INTEGER,
no_charge_reference TEXT,
no_charge_environment TEXT,
no_charge_case_id TEXT,
no_charge_operator_id TEXT,
no_charge_confirmed_at_ms INTEGER,
recovery_case_id TEXT,
recovery_reviewed_at_ms INTEGER,
paid_attempt_id TEXT GENERATED ALWAYS AS(CASE WHEN paid_starts_at_ms IS NOT NULL THEN id END) VIRTUAL UNIQUE,
UNIQUE (user_id, payment_request_id),
CHECK((paid_starts_at_ms IS NULL AND paid_starts_at_ms IS NULL AND paid_ends_at_ms IS NULL AND paid_renewal_anchor_ms IS NULL) OR (paid_starts_at_ms IS NOT NULL AND paid_starts_at_ms IS NOT NULL AND paid_ends_at_ms IS NOT NULL AND (paid_ends_at_ms > paid_starts_at_ms) AND paid_renewal_anchor_ms IS NOT NULL)),
CHECK((checkout_transaction_id IS NULL AND checkout_transaction_id IS NULL) OR (checkout_transaction_id IS NOT NULL AND checkout_transaction_id IS NOT NULL)),
CHECK((collection_state IS NULL AND collection_state IS NULL AND collection_sent_at_ms IS NULL AND collection_last_attempt_at_ms IS NULL) OR (collection_state IS NOT NULL AND collection_state IS NOT NULL AND (collection_state IN ('armed','sent','rejected')))),
CHECK((followup_kind IS NULL AND followup_kind IS NULL AND followup_due_at_ms IS NULL) OR (followup_kind IS NOT NULL AND followup_kind IS NOT NULL AND (followup_kind = 'renewal_due') AND followup_due_at_ms IS NOT NULL)),
CHECK((no_charge_confirmed_at_ms IS NULL AND no_charge_reference IS NULL AND no_charge_environment IS NULL AND no_charge_case_id IS NULL AND no_charge_operator_id IS NULL AND no_charge_confirmed_at_ms IS NULL) OR (no_charge_confirmed_at_ms IS NOT NULL AND no_charge_reference IS NOT NULL AND no_charge_environment IS NOT NULL AND no_charge_case_id IS NOT NULL AND (length(trim(no_charge_case_id)) BETWEEN 1 AND 128) AND no_charge_operator_id IS NOT NULL AND (length(trim(no_charge_operator_id)) BETWEEN 1 AND 128) AND no_charge_confirmed_at_ms IS NOT NULL AND (no_charge_confirmed_at_ms > 0))),
CHECK((recovery_case_id IS NULL AND recovery_case_id IS NULL AND recovery_reviewed_at_ms IS NULL) OR (recovery_case_id IS NOT NULL AND recovery_case_id IS NOT NULL AND recovery_reviewed_at_ms IS NOT NULL))) STRICT;

INSERT INTO billing_attempts_consolidated(id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,status,created_at_ms,finalized_at_ms,previous_paid_attempt_id,period_starts_at_ms,period_ends_at_ms,attempt_number,calendar_anchor_ms,renewal_attempt_number,paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms,checkout_transaction_id,collection_state,collection_sent_at_ms,collection_last_attempt_at_ms,followup_kind,followup_due_at_ms,no_charge_reference,no_charge_environment,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms,recovery_case_id,recovery_reviewed_at_ms) SELECT id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,status,created_at_ms,finalized_at_ms,previous_paid_attempt_id,period_starts_at_ms,period_ends_at_ms,attempt_number,calendar_anchor_ms,renewal_attempt_number,(SELECT starts_at_ms FROM billing_paid_periods WHERE attempt_id=billing_attempts.id),(SELECT ends_at_ms FROM billing_paid_periods WHERE attempt_id=billing_attempts.id),(SELECT renewal_anchor_ms FROM billing_paid_periods WHERE attempt_id=billing_attempts.id),(SELECT transaction_id FROM billing_checkout_responses WHERE attempt_id=billing_attempts.id),(SELECT state FROM billing_collection_work WHERE attempt_id=billing_attempts.id),(SELECT sent_at_ms FROM billing_collection_work WHERE attempt_id=billing_attempts.id),(SELECT last_attempt_at_ms FROM billing_collection_work WHERE attempt_id=billing_attempts.id),(SELECT kind FROM billing_followup_outbox WHERE attempt_id=billing_attempts.id),(SELECT due_at_ms FROM billing_followup_outbox WHERE attempt_id=billing_attempts.id),(SELECT wompi_reference FROM billing_no_charge_confirmations WHERE attempt_id=billing_attempts.id),(SELECT wompi_environment FROM billing_no_charge_confirmations WHERE attempt_id=billing_attempts.id),(SELECT provider_case_id FROM billing_no_charge_confirmations WHERE attempt_id=billing_attempts.id),(SELECT operator_id FROM billing_no_charge_confirmations WHERE attempt_id=billing_attempts.id),(SELECT confirmed_at_ms FROM billing_no_charge_confirmations WHERE attempt_id=billing_attempts.id),(SELECT provider_case_id FROM billing_recovery_reviews WHERE attempt_id=billing_attempts.id),(SELECT occurred_at_ms FROM billing_recovery_reviews WHERE attempt_id=billing_attempts.id) FROM billing_attempts;

DROP TABLE billing_attempts;

ALTER TABLE billing_attempts_consolidated RENAME TO billing_attempts;

CREATE INDEX billing_pending_health ON billing_attempts(created_at_ms) WHERE status = 'pending';

CREATE UNIQUE INDEX billing_renewal_identity ON billing_attempts(previous_paid_attempt_id, renewal_attempt_number)
WHERE previous_paid_attempt_id IS NOT NULL;

CREATE TABLE refund_attempts_consolidated (
id TEXT PRIMARY KEY CHECK (length(id) = 36),
user_id TEXT NOT NULL REFERENCES users(id),
subscription_id TEXT NOT NULL REFERENCES subscription_identities(id),
billing_attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
transaction_id TEXT NOT NULL REFERENCES billing_provider_transactions(evidence_transaction_id),
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
work_version INTEGER DEFAULT 1,
dispatch_last_attempt_at_ms INTEGER,
published_at_ms INTEGER,
verification_attempts INTEGER DEFAULT 0,
last_verification_at_ms INTEGER,
submission_claimed_at_ms INTEGER,
provider_refund_id TEXT UNIQUE,
verified_status TEXT,
observed_at_ms INTEGER,
adjusted_attempt_id TEXT REFERENCES billing_attempts(paid_attempt_id),
access_ends_at_ms INTEGER,
renewal_stopped_user_id TEXT REFERENCES users(id),
renewal_stopped_at_ms INTEGER,
UNIQUE (user_id,request_id),
CHECK ((status='pending' AND finalized_at_ms IS NULL AND failure IS NULL)
    OR (status='succeeded' AND finalized_at_ms IS NOT NULL AND failure IS NULL)
    OR (status='failed' AND finalized_at_ms IS NOT NULL AND failure IS NOT NULL)),
CHECK((work_version IS NULL AND work_version IS NULL AND dispatch_last_attempt_at_ms IS NULL AND published_at_ms IS NULL AND verification_attempts IS NULL AND last_verification_at_ms IS NULL) OR (work_version IS NOT NULL AND work_version IS NOT NULL AND (work_version=1) AND verification_attempts IS NOT NULL AND (verification_attempts BETWEEN 0 AND 8))),
CHECK((submission_claimed_at_ms IS NULL AND submission_claimed_at_ms IS NULL) OR (submission_claimed_at_ms IS NOT NULL AND submission_claimed_at_ms IS NOT NULL)),
CHECK((verified_status IS NULL AND provider_refund_id IS NULL AND verified_status IS NULL AND observed_at_ms IS NULL) OR (verified_status IS NOT NULL AND (provider_refund_id IS NULL OR length(provider_refund_id) BETWEEN 1 AND 128) AND verified_status IS NOT NULL AND (verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED')) AND observed_at_ms IS NOT NULL)),
CHECK((adjusted_attempt_id IS NULL AND adjusted_attempt_id IS NULL AND access_ends_at_ms IS NULL) OR (adjusted_attempt_id IS NOT NULL AND adjusted_attempt_id IS NOT NULL AND access_ends_at_ms IS NOT NULL)),
CHECK((renewal_stopped_at_ms IS NULL AND renewal_stopped_user_id IS NULL AND renewal_stopped_at_ms IS NULL) OR (renewal_stopped_at_ms IS NOT NULL AND renewal_stopped_user_id IS NOT NULL AND renewal_stopped_at_ms IS NOT NULL))) STRICT;

INSERT INTO refund_attempts_consolidated(id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,work_version,dispatch_last_attempt_at_ms,published_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,adjusted_attempt_id,access_ends_at_ms,renewal_stopped_user_id,renewal_stopped_at_ms) SELECT id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,(SELECT version FROM refund_outbox WHERE refund_id=refund_attempts.id),(SELECT last_attempt_at_ms FROM refund_outbox WHERE refund_id=refund_attempts.id),(SELECT published_at_ms FROM refund_outbox WHERE refund_id=refund_attempts.id),(SELECT verification_attempts FROM refund_outbox WHERE refund_id=refund_attempts.id),(SELECT last_verification_at_ms FROM refund_outbox WHERE refund_id=refund_attempts.id),(SELECT claimed_at_ms FROM refund_submission_claims WHERE refund_id=refund_attempts.id),(SELECT provider_id FROM refund_outcome_evidence WHERE refund_id=refund_attempts.id),(SELECT verified_status FROM refund_outcome_evidence WHERE refund_id=refund_attempts.id),(SELECT observed_at_ms FROM refund_outcome_evidence WHERE refund_id=refund_attempts.id),(SELECT attempt_id FROM billing_access_adjustments WHERE refund_id=refund_attempts.id),(SELECT ends_at_ms FROM billing_access_adjustments WHERE refund_id=refund_attempts.id),(SELECT user_id FROM subscription_renewal_stops WHERE refund_id=refund_attempts.id),(SELECT stopped_at_ms FROM subscription_renewal_stops WHERE refund_id=refund_attempts.id) FROM refund_attempts;

DROP TABLE refund_attempts;

ALTER TABLE refund_attempts_consolidated RENAME TO refund_attempts;

CREATE INDEX refunds_by_charge ON refund_attempts(billing_attempt_id,status);

CREATE INDEX refunds_by_user ON refund_attempts(user_id,created_at_ms);

CREATE TABLE subscription_cancellations_consolidated (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  paid_attempt_id TEXT NOT NULL REFERENCES billing_attempts(paid_attempt_id),
  payment_source_id TEXT NOT NULL REFERENCES card_payment_sources(id),
  cancelled_at_ms INTEGER NOT NULL,
  paid_through_ms INTEGER NOT NULL,
  source_cancellation TEXT NOT NULL CHECK (source_cancellation IN ('detached','void-pending','voided')),
  void_started_at_ms INTEGER,
  void_verified_at_ms INTEGER,
  verification_count INTEGER NOT NULL DEFAULT 0 CHECK (verification_count BETWEEN 0 AND 8),
  last_offered_at_ms INTEGER
) STRICT;

INSERT INTO subscription_cancellations_consolidated(user_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation,void_started_at_ms,void_verified_at_ms,verification_count,last_offered_at_ms) SELECT user_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation,void_started_at_ms,void_verified_at_ms,verification_count,last_offered_at_ms FROM subscription_cancellations;

DROP TABLE subscription_cancellations;

ALTER TABLE subscription_cancellations_consolidated RENAME TO subscription_cancellations;

DROP TABLE billing_paid_periods;

DROP TABLE billing_checkout_responses;

DROP TABLE billing_collection_work;

DROP TABLE billing_followup_outbox;

DROP TABLE billing_no_charge_confirmations;

DROP TABLE billing_recovery_reviews;

DROP TABLE refund_outbox;

DROP TABLE refund_submission_claims;

DROP TABLE refund_outcome_evidence;

DROP TABLE billing_access_adjustments;

DROP TABLE subscription_renewal_stops;

DROP TABLE billing_transaction_candidates;

DROP TABLE billing_transaction_evidence;

CREATE INDEX billing_collection_work_due ON billing_attempts(collection_last_attempt_at_ms,id) WHERE collection_state='armed' AND collection_state IS NOT NULL;

CREATE INDEX billing_access_by_period ON refund_attempts(adjusted_attempt_id,access_ends_at_ms) WHERE adjusted_attempt_id IS NOT NULL;

CREATE INDEX billing_provider_transaction_attempt ON billing_provider_transactions(attempt_id,status);

CREATE TRIGGER billing_attempt_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.user_id <> OLD.user_id OR NEW.enrollment_id <> OLD.enrollment_id
  OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.payment_source_id <> OLD.payment_source_id
  OR NEW.price_id <> OLD.price_id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
  OR NEW.billing_period <> OLD.billing_period OR NEW.service_market <> OLD.service_market
  OR NEW.tax_treatment <> OLD.tax_treatment OR NEW.time_zone <> OLD.time_zone
  OR NEW.wompi_environment <> OLD.wompi_environment OR NEW.wompi_reference <> OLD.wompi_reference
  OR NEW.created_at_ms <> OLD.created_at_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_snapshot_immutable');
END;

CREATE TRIGGER billing_no_charge_immutable_update BEFORE UPDATE OF no_charge_reference,no_charge_environment,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL AND (NEW.no_charge_reference IS NOT OLD.no_charge_reference OR NEW.no_charge_environment IS NOT OLD.no_charge_environment OR NEW.no_charge_case_id IS NOT OLD.no_charge_case_id OR NEW.no_charge_operator_id IS NOT OLD.no_charge_operator_id OR NEW.no_charge_confirmed_at_ms IS NOT OLD.no_charge_confirmed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_no_charge_immutable');
END;

CREATE TRIGGER billing_attempt_terminal_monotonic BEFORE UPDATE ON billing_attempts
WHEN (OLD.status = 'succeeded' AND NEW.status <> 'succeeded')
  OR (OLD.status = 'failed' AND NEW.status = 'pending')
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_terminal_immutable');
END;

CREATE TRIGGER billing_paid_period_immutable_update BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NOT NULL AND (NEW.paid_starts_at_ms IS NOT OLD.paid_starts_at_ms OR NEW.paid_ends_at_ms IS NOT OLD.paid_ends_at_ms OR NEW.paid_renewal_anchor_ms IS NOT OLD.paid_renewal_anchor_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_paid_period_immutable');
END;

CREATE TRIGGER refund_acceptance_limit BEFORE INSERT ON refund_attempts
WHEN (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id AND status='pending')>=4
 OR (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id
   AND created_at_ms>NEW.created_at_ms-3600000)>=12
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.subscription_id<>OLD.subscription_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.snapshot_json<>OLD.snapshot_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents OR NEW.original_cents<>OLD.original_cents
 OR NEW.kind<>OLD.kind OR NEW.operator_id<>OLD.operator_id OR NEW.created_at_ms<>OLD.created_at_ms
 OR (OLD.status<>'pending' AND (NEW.status<>OLD.status OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms
   OR NEW.failure IS NOT OLD.failure OR NEW.progress<>OLD.progress))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END;

CREATE TRIGGER refund_claim_requires_pending BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NULL AND NEW.submission_claimed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r
  JOIN billing_attempts a ON a.id=r.billing_attempt_id
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.transaction_id=r.transaction_id AND e.attempt_id=a.id
  WHERE r.id=NEW.id AND r.status='pending' AND a.status='succeeded'
    AND a.wompi_environment='sandbox' AND e.status='APPROVED'
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence
      WHERE attempt_id=a.id AND status='APPROVED')=1))
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER refund_claim_immutable BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NOT NULL AND (NEW.submission_claimed_at_ms IS NOT OLD.submission_claimed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_claim_immutable');
END;

CREATE TRIGGER refund_evidence_requires_claim BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r JOIN (SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL) c ON c.refund_id=r.id
  WHERE r.id=NEW.id AND r.status='pending' AND NEW.observed_at_ms>=r.created_at_ms
    AND ((r.kind='refund' AND NEW.verified_status IN ('APPROVED','DECLINED','CANCELLED'))
      OR (r.kind='card-void' AND NEW.verified_status='VOIDED'))))
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_invalid_claim');
END;

CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NOT NULL AND (NEW.provider_refund_id IS NOT OLD.provider_refund_id OR NEW.verified_status IS NOT OLD.verified_status OR NEW.observed_at_ms IS NOT OLD.observed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_immutable');
END;

CREATE TRIGGER refund_verified_settlement AFTER UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL
BEGIN
 UPDATE refund_attempts SET status=CASE WHEN NEW.verified_status IN ('APPROVED','VOIDED')
    THEN 'succeeded' ELSE 'failed' END, finalized_at_ms=NEW.observed_at_ms,
    failure=CASE NEW.verified_status WHEN 'DECLINED' THEN 'provider-declined'
      WHEN 'CANCELLED' THEN 'provider-cancelled' ELSE NULL END
    WHERE id=NEW.id AND status='pending';
 UPDATE refund_attempts SET adjusted_attempt_id=incoming.attempt_id,access_ends_at_ms=incoming.ends_at_ms FROM (SELECT id AS refund_id,billing_attempt_id AS attempt_id,NEW.observed_at_ms AS ends_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.adjusted_attempt_id IS NULL;
 UPDATE refund_attempts SET renewal_stopped_user_id=incoming.user_id,renewal_stopped_at_ms=incoming.stopped_at_ms FROM (SELECT id AS refund_id,user_id AS user_id,NEW.observed_at_ms AS stopped_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.renewal_stopped_at_ms IS NULL;
 UPDATE billing_attempts AS billing_followup_outbox SET followup_kind=NULL,followup_due_at_ms=NULL WHERE followup_kind IS NOT NULL AND id IN
    (SELECT a.id FROM billing_attempts a JOIN refund_attempts r ON r.user_id=a.user_id
      WHERE r.id=NEW.id AND r.status='succeeded');
END;

CREATE TRIGGER billing_access_adjustment_immutable BEFORE UPDATE OF adjusted_attempt_id,access_ends_at_ms ON refund_attempts
WHEN OLD.adjusted_attempt_id IS NOT NULL AND (NEW.adjusted_attempt_id IS NOT OLD.adjusted_attempt_id OR NEW.access_ends_at_ms IS NOT OLD.access_ends_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_access_adjustment_immutable');
END;

CREATE TRIGGER subscription_renewal_stop_immutable BEFORE UPDATE OF renewal_stopped_user_id,renewal_stopped_at_ms ON refund_attempts
WHEN OLD.renewal_stopped_at_ms IS NOT NULL AND (NEW.renewal_stopped_user_id IS NOT OLD.renewal_stopped_user_id OR NEW.renewal_stopped_at_ms IS NOT OLD.renewal_stopped_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable');
END;

CREATE TRIGGER billing_followup_refund_stop BEFORE UPDATE OF followup_kind,followup_due_at_ms ON billing_attempts
WHEN OLD.followup_kind IS NULL AND NEW.followup_kind IS NOT NULL AND (EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) s JOIN billing_attempts a ON a.user_id=s.user_id
 WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER billing_renewal_period_guard BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempts a WHERE a.id = NEW.id
  AND a.previous_paid_attempt_id IS NOT NULL AND
    (NEW.paid_starts_at_ms <> a.period_starts_at_ms OR NEW.paid_ends_at_ms <> a.period_ends_at_ms
      OR NEW.paid_renewal_anchor_ms <> a.period_ends_at_ms)))
BEGIN
 SELECT RAISE(ABORT, 'billing_renewal_period_mismatch');
END;

CREATE TRIGGER billing_calendar_anchor_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.calendar_anchor_ms IS NOT OLD.calendar_anchor_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_calendar_anchor_immutable');
END;

CREATE TRIGGER billing_renewal_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.previous_paid_attempt_id IS NOT OLD.previous_paid_attempt_id
  OR NEW.period_starts_at_ms IS NOT OLD.period_starts_at_ms
  OR NEW.attempt_number <> OLD.attempt_number
  OR NEW.period_ends_at_ms IS NOT OLD.period_ends_at_ms OR NEW.renewal_attempt_number <> OLD.renewal_attempt_number
BEGIN
 SELECT RAISE(ABORT, 'billing_renewal_immutable');
END;

CREATE TRIGGER billing_renewal_period_once BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempts a JOIN billing_attempts sibling
  ON sibling.previous_paid_attempt_id = a.previous_paid_attempt_id
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id = sibling.id
  WHERE a.id = NEW.id AND a.previous_paid_attempt_id IS NOT NULL))
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER subscription_cancellation_immutable BEFORE UPDATE ON subscription_cancellations
WHEN NEW.user_id<>OLD.user_id OR NEW.paid_attempt_id<>OLD.paid_attempt_id OR NEW.payment_source_id<>OLD.payment_source_id
 OR NEW.cancelled_at_ms<>OLD.cancelled_at_ms OR NEW.paid_through_ms<>OLD.paid_through_ms
 OR (OLD.source_cancellation IN ('detached','voided') AND NEW.source_cancellation<>OLD.source_cancellation)
 OR (OLD.void_started_at_ms IS NOT NULL AND NEW.void_started_at_ms IS NOT OLD.void_started_at_ms)
 OR (OLD.void_verified_at_ms IS NOT NULL AND NEW.void_verified_at_ms IS NOT OLD.void_verified_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;

CREATE TRIGGER billing_attempt_detached_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM subscription_cancellations WHERE payment_source_id=NEW.payment_source_id)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_detached');
END;

CREATE TRIGGER billing_followup_cancellation_stop BEFORE UPDATE OF followup_kind,followup_due_at_ms ON billing_attempts
WHEN OLD.followup_kind IS NULL AND NEW.followup_kind IS NOT NULL AND (EXISTS (SELECT 1 FROM subscription_cancellations c JOIN billing_attempts a ON a.user_id=c.user_id WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_attempts' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END;

CREATE TRIGGER subscription_cancellation_no_delete BEFORE DELETE ON subscription_cancellations
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_cancellations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;

CREATE TRIGGER erasure_fence_billing_attempts_insert BEFORE INSERT ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_billing_attempts_update BEFORE UPDATE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history')) AND NOT (EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing') AND NEW.checkout_transaction_id IS NULL AND NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.enrollment_id IS OLD.enrollment_id AND NEW.payment_request_id IS OLD.payment_request_id AND NEW.payment_source_id IS OLD.payment_source_id AND NEW.price_id IS OLD.price_id AND NEW.amount IS OLD.amount AND NEW.currency IS OLD.currency AND NEW.billing_period IS OLD.billing_period AND NEW.service_market IS OLD.service_market AND NEW.tax_treatment IS OLD.tax_treatment AND NEW.time_zone IS OLD.time_zone AND NEW.wompi_environment IS OLD.wompi_environment AND NEW.wompi_reference IS OLD.wompi_reference AND NEW.status IS OLD.status AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.finalized_at_ms IS OLD.finalized_at_ms AND NEW.previous_paid_attempt_id IS OLD.previous_paid_attempt_id AND NEW.period_starts_at_ms IS OLD.period_starts_at_ms AND NEW.period_ends_at_ms IS OLD.period_ends_at_ms AND NEW.attempt_number IS OLD.attempt_number AND NEW.calendar_anchor_ms IS OLD.calendar_anchor_ms AND NEW.renewal_attempt_number IS OLD.renewal_attempt_number AND NEW.paid_starts_at_ms IS OLD.paid_starts_at_ms AND NEW.paid_ends_at_ms IS OLD.paid_ends_at_ms AND NEW.paid_renewal_anchor_ms IS OLD.paid_renewal_anchor_ms AND NEW.collection_state IS OLD.collection_state AND NEW.collection_sent_at_ms IS OLD.collection_sent_at_ms AND NEW.collection_last_attempt_at_ms IS OLD.collection_last_attempt_at_ms AND NEW.followup_kind IS OLD.followup_kind AND NEW.followup_due_at_ms IS OLD.followup_due_at_ms AND NEW.no_charge_reference IS OLD.no_charge_reference AND NEW.no_charge_environment IS OLD.no_charge_environment AND NEW.no_charge_case_id IS OLD.no_charge_case_id AND NEW.no_charge_operator_id IS OLD.no_charge_operator_id AND NEW.no_charge_confirmed_at_ms IS OLD.no_charge_confirmed_at_ms AND NEW.recovery_case_id IS OLD.recovery_case_id AND NEW.recovery_reviewed_at_ms IS OLD.recovery_reviewed_at_ms)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_refund_attempts_insert BEFORE INSERT ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_refund_attempts_update BEFORE UPDATE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_subscription_cancellations_insert BEFORE INSERT ON subscription_cancellations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_subscription_cancellations_update BEFORE UPDATE ON subscription_cancellations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_subscription_cancellations_delete BEFORE DELETE ON subscription_cancellations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_billing_event_candidates_insert BEFORE INSERT ON billing_event_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=NEW.transaction_id AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_billing_event_candidates_update BEFORE UPDATE ON billing_event_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=NEW.transaction_id AND a.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_billing_event_candidates_delete BEFORE DELETE ON billing_event_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_billing_event_candidates_delete BEFORE DELETE ON billing_event_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."received_at_ms",'signed_at',OLD."signed_at",'signed_status',OLD."signed_status",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms",'resolved_at_ms',OLD."resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'subscription_id',OLD."subscription_id",'billing_attempt_id',OLD."billing_attempt_id",'transaction_id',OLD."transaction_id",'request_id',OLD."request_id",'intent_json',OLD."intent_json",'snapshot_json',OLD."snapshot_json",'amount_in_cents',OLD."amount_in_cents",'original_cents',OLD."original_cents",'kind',OLD."kind",'operator_id',OLD."operator_id",'created_at_ms',OLD."created_at_ms",'status',OLD."status",'progress',OLD."progress",'finalized_at_ms',OLD."finalized_at_ms",'failure',OLD."failure",'work_version',OLD.work_version,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'published_at_ms',OLD.published_at_ms,'verification_attempts',OLD.verification_attempts,'last_verification_at_ms',OLD.last_verification_at_ms,'submission_claimed_at_ms',OLD.submission_claimed_at_ms,'provider_refund_id',OLD.provider_refund_id,'verified_status',OLD.verified_status,'observed_at_ms',OLD.observed_at_ms,'adjusted_attempt_id',OLD.adjusted_attempt_id,'access_ends_at_ms',OLD.access_ends_at_ms,'renewal_stopped_user_id',OLD.renewal_stopped_user_id,'renewal_stopped_at_ms',OLD.renewal_stopped_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_subscription_cancellations_delete BEFORE DELETE ON subscription_cancellations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_cancellations','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'paid_attempt_id',OLD."paid_attempt_id",'payment_source_id',OLD."payment_source_id",'cancelled_at_ms',OLD."cancelled_at_ms",'paid_through_ms',OLD."paid_through_ms",'source_cancellation',OLD."source_cancellation",'void_started_at_ms',OLD."void_started_at_ms",'void_verified_at_ms',OLD."void_verified_at_ms",'verification_count',OLD."verification_count",'last_offered_at_ms',OLD."last_offered_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_history','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'enrollment_id',OLD."enrollment_id",'payment_request_id',OLD."payment_request_id",'payment_source_id',OLD."payment_source_id",'price_id',OLD."price_id",'amount',OLD."amount",'currency',OLD."currency",'billing_period',OLD."billing_period",'service_market',OLD."service_market",'tax_treatment',OLD."tax_treatment",'time_zone',OLD."time_zone",'wompi_environment',OLD."wompi_environment",'wompi_reference',OLD."wompi_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'finalized_at_ms',OLD."finalized_at_ms",'previous_paid_attempt_id',OLD."previous_paid_attempt_id",'period_starts_at_ms',OLD."period_starts_at_ms",'period_ends_at_ms',OLD."period_ends_at_ms",'attempt_number',OLD."attempt_number",'calendar_anchor_ms',OLD."calendar_anchor_ms",'renewal_attempt_number',OLD."renewal_attempt_number",'paid_starts_at_ms',OLD.paid_starts_at_ms,'paid_ends_at_ms',OLD.paid_ends_at_ms,'paid_renewal_anchor_ms',OLD.paid_renewal_anchor_ms,'checkout_transaction_id',OLD.checkout_transaction_id,'collection_state',OLD.collection_state,'collection_sent_at_ms',OLD.collection_sent_at_ms,'collection_last_attempt_at_ms',OLD.collection_last_attempt_at_ms,'followup_kind',OLD.followup_kind,'followup_due_at_ms',OLD.followup_due_at_ms,'no_charge_reference',OLD.no_charge_reference,'no_charge_environment',OLD.no_charge_environment,'no_charge_case_id',OLD.no_charge_case_id,'no_charge_operator_id',OLD.no_charge_operator_id,'no_charge_confirmed_at_ms',OLD.no_charge_confirmed_at_ms,'recovery_case_id',OLD.recovery_case_id,'recovery_reviewed_at_ms',OLD.recovery_reviewed_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER billing_checkout_response_no_update BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NOT NULL AND (NEW.checkout_transaction_id IS NOT OLD.checkout_transaction_id) AND NOT(NEW.checkout_transaction_id IS NULL AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing'))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_immutable');
END;

CREATE TRIGGER payment_attempt_method_guard BEFORE INSERT ON billing_attempts
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  JOIN card_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN card_enrollments AS origin ON origin.id = s.enrollment_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = s.method
    AND (e.wompi_environment = NEW.wompi_environment OR (e.wompi_environment IS NULL AND e.method = 'card'))
    AND (origin.wompi_environment = NEW.wompi_environment OR (origin.wompi_environment IS NULL AND origin.method = 'card'))
    AND NOT EXISTS (SELECT 1 FROM billing_attempts AS prior
      WHERE prior.payment_source_id = s.id AND prior.wompi_environment <> NEW.wompi_environment))
BEGIN
 SELECT RAISE(ABORT, 'payment_attempt_method_mismatch');
END;

CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN subscription_identities s ON s.user_id=a.user_id
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.attempt_id=a.id
  JOIN card_payment_sources p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND s.id=NEW.subscription_id
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > NEW.original_cents - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR EXISTS (SELECT 1 FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id
    AND original_cents<>NEW.original_cents)
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER weekly_price_notice AFTER UPDATE OF published_order ON subscription_prices
WHEN NEW.published_order = 1 AND OLD.published_order IS NULL
BEGIN
 INSERT OR IGNORE INTO billing_price_notices (user_id, price_id, created_at_ms)
    SELECT s.user_id, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM subscriptions s
    JOIN billing_attempts a ON a.id=s.attempt_id AND a.user_id=s.user_id
    JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=s.user_id
    WHERE a.billing_period='weekly' AND source.method='card' AND a.price_id<>NEW.id
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) stop WHERE stop.user_id=s.user_id);
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
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) period ON period.attempt_id = prior.id
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
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_invalid_claim');
END;

CREATE TRIGGER subscription_cancellation_guard BEFORE INSERT ON subscription_cancellations
WHEN NOT EXISTS (SELECT 1 FROM subscriptions sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.user_id AND a.id=NEW.paid_attempt_id AND a.payment_source_id=NEW.payment_source_id
 AND NEW.paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;

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
BEGIN
 SELECT RAISE(ABORT, 'card_source_immutable');
END;

CREATE TRIGGER billing_attempt_retired_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM card_payment_sources source WHERE source.id=NEW.payment_source_id AND source.retired_at_ms IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_retired');
END;

CREATE TRIGGER billing_no_charge_requires_sent_arm BEFORE UPDATE OF no_charge_reference,no_charge_environment,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NULL AND NEW.no_charge_confirmed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempts AS a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) AS arm ON arm.attempt_id = a.id
  WHERE a.id = NEW.id AND a.wompi_reference = NEW.no_charge_reference
    AND a.wompi_environment = NEW.no_charge_environment AND a.status <> 'succeeded'
    AND arm.state = 'sent'))
BEGIN
 SELECT RAISE(ABORT, 'billing_no_charge_unverified_arm');
END;

CREATE TRIGGER billing_renewal_success_fence AFTER UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL
BEGIN
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed' AND id<>NEW.id
    AND id IN (SELECT sibling.id FROM billing_attempts sibling JOIN billing_attempts success
      ON success.previous_paid_attempt_id=sibling.previous_paid_attempt_id WHERE success.id=NEW.id
      AND success.previous_paid_attempt_id IS NOT NULL);
END;

CREATE TRIGGER subscription_cancellation_fence AFTER INSERT ON subscription_cancellations
BEGIN
 UPDATE billing_attempts AS billing_followup_outbox SET followup_kind=NULL,followup_due_at_ms=NULL WHERE followup_kind IS NOT NULL AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed'
    AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
END;

CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempts AS prior
  WHERE prior.user_id=NEW.user_id
    AND (prior.status='pending' OR (prior.status='failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,no_charge_reference AS wompi_reference,no_charge_environment AS wompi_environment,no_charge_case_id AS provider_case_id,no_charge_operator_id AS operator_id,no_charge_confirmed_at_ms AS confirmed_at_ms FROM billing_attempts WHERE no_charge_confirmed_at_ms IS NOT NULL) clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempts success
        JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN
 SELECT RAISE(ABORT, 'billing_user_collection_unresolved');
END;

CREATE TRIGGER billing_checkout_response_guard BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NULL AND NEW.checkout_transaction_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) arm ON arm.attempt_id=a.id
  JOIN (SELECT rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms FROM billing_provider_transactions) candidate ON candidate.attempt_id=a.id
  JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.id AND candidate.transaction_id=NEW.checkout_transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_invalid');
END;

CREATE TRIGGER erasure_fence_audit_entries_insert BEFORE INSERT ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_audit_entries_update BEFORE UPDATE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND (COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id OR COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id)
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_audit_entries_delete BEFORE DELETE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE OLD.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_audit_entries_billing_transition BEFORE DELETE ON audit_entries
WHEN OLD.record_type='billing_transition' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_audit','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'transition',OLD."transition",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM subscription_cancellations;

CREATE VIEW billing_retry_clearances AS
SELECT a.id AS attempt_id FROM billing_attempts a
JOIN (SELECT rowid,id AS attempt_id,checkout_transaction_id AS transaction_id FROM billing_attempts WHERE checkout_transaction_id IS NOT NULL) response ON response.attempt_id=a.id
JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) evidence ON evidence.transaction_id=response.transaction_id AND evidence.attempt_id=a.id
WHERE a.status='failed' AND evidence.status='DECLINED' AND evidence.finalized_at_ms IS NOT NULL
  AND evidence.negative_observed_at_ms<=a.finalized_at_ms-180000
  AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms FROM billing_provider_transactions) candidate
    WHERE candidate.attempt_id=a.id AND candidate.transaction_id<>response.transaction_id)
  AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid WHERE paid.attempt_id=a.id);

CREATE TRIGGER billing_evidence_reject_foreign_id BEFORE INSERT ON billing_provider_transactions
WHEN EXISTS (SELECT 1 FROM billing_provider_transactions AS e
  WHERE e.transaction_id = NEW.transaction_id AND e.attempt_id <> NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'billing_evidence_foreign_transaction'); END;

CREATE TRIGGER billing_evidence_immutable_identity BEFORE UPDATE ON billing_provider_transactions
WHEN NEW.transaction_id <> OLD.transaction_id OR NEW.attempt_id <> OLD.attempt_id
BEGIN SELECT RAISE(ABORT, 'billing_evidence_identity_immutable'); END;

CREATE TRIGGER billing_evidence_approval_monotonic BEFORE UPDATE ON billing_provider_transactions
WHEN OLD.status = 'APPROVED' AND NEW.status IS NOT 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'billing_evidence_approval_immutable'); END;

CREATE TRIGGER erasure_fence_billing_provider_transactions_insert BEFORE INSERT ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_provider_transactions_update BEFORE UPDATE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_provider_transactions','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms",'status',OLD.status,'first_observed_at_ms',OLD.first_observed_at_ms,'negative_observed_at_ms',OLD.negative_observed_at_ms,'finalized_at_ms',OLD.finalized_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER billing_history_no_delete BEFORE DELETE ON billing_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.user_id=OLD.user_id AND p.store_id='billing_history' AND q.user_id=p.user_id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'billing_history_immutable'); END;

CREATE TRIGGER billing_companions_initial BEFORE INSERT ON billing_attempts WHEN NEW.paid_starts_at_ms IS NOT NULL OR NEW.checkout_transaction_id IS NOT NULL OR NEW.followup_kind IS NOT NULL OR NEW.no_charge_confirmed_at_ms IS NOT NULL OR NEW.recovery_case_id IS NOT NULL OR NEW.collection_state IS NOT 'armed' OR NEW.collection_sent_at_ms IS NOT NULL OR NEW.collection_last_attempt_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'billing_companions_initial'); END;

CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.work_version IS NOT 1 OR NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.published_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.adjusted_attempt_id IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_billing_companions',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope IN('migration_billing_identity','migration_billing_companions');

PRAGMA defer_foreign_keys=OFF;
