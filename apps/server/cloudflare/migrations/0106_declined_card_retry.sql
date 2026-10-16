CREATE TABLE billing_checkout_responses (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES billing_attempts(id),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES billing_transaction_candidates(transaction_id)
) STRICT;
CREATE TRIGGER billing_checkout_response_guard BEFORE INSERT ON billing_checkout_responses
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN billing_collection_arms arm ON arm.attempt_id=a.id
  JOIN billing_transaction_candidates candidate ON candidate.attempt_id=a.id
  JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.attempt_id AND candidate.transaction_id=NEW.transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'billing_checkout_response_invalid'); END;
CREATE TRIGGER billing_checkout_response_no_update BEFORE UPDATE ON billing_checkout_responses
BEGIN SELECT RAISE(ABORT, 'billing_checkout_response_immutable'); END;
CREATE TRIGGER billing_checkout_response_no_delete BEFORE DELETE ON billing_checkout_responses
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='billing_checkout_responses' AND p.user_id=q.user_id AND q.state='Erasing'
 AND EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=OLD.attempt_id AND a.user_id=p.user_id))
BEGIN SELECT RAISE(ABORT, 'billing_checkout_response_immutable'); END;

-- A known direct-card response plus verified final decline is distinct from a lost POST.
-- Wompi permits another transaction under a checkout reference for three minutes:
-- https://docs.wompi.co/docs/colombia/reintento-de-pago/
CREATE VIEW billing_retry_clearances AS
SELECT a.id AS attempt_id FROM billing_attempts a
JOIN billing_checkout_responses response ON response.attempt_id=a.id
JOIN billing_transaction_evidence evidence ON evidence.transaction_id=response.transaction_id AND evidence.attempt_id=a.id
WHERE a.status='failed' AND evidence.status='DECLINED' AND evidence.finalized_at_ms IS NOT NULL
  AND evidence.negative_observed_at_ms<=a.finalized_at_ms-180000
  AND NOT EXISTS (SELECT 1 FROM billing_transaction_candidates candidate
    WHERE candidate.attempt_id=a.id AND candidate.transaction_id<>response.transaction_id)
  AND NOT EXISTS (SELECT 1 FROM billing_paid_periods paid WHERE paid.attempt_id=a.id);

DROP TRIGGER billing_attempt_user_collection_guard;
CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempts AS prior
  WHERE prior.user_id=NEW.user_id
    AND (prior.status='pending' OR (prior.status='failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_collection_arms stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempts success
        JOIN billing_paid_periods paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN SELECT RAISE(ABORT, 'billing_user_collection_unresolved'); END;

CREATE TRIGGER erasure_fence_billing_checkout_responses_insert BEFORE INSERT ON billing_checkout_responses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_checkout_responses'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_checkout_responses_update BEFORE UPDATE ON billing_checkout_responses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_checkout_responses'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_checkout_responses_delete BEFORE DELETE ON billing_checkout_responses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_checkout_responses'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_billing_checkout_responses_delete BEFORE DELETE ON billing_checkout_responses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_checkout_responses','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
