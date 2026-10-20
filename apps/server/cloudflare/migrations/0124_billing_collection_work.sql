-- Keep the send claim and Queue dispatch cooldown on the same billing attempt.
-- Refuse an inconsistent predecessor rather than inventing permission to charge.
CREATE TABLE billing_collection_work (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES billing_attempts(id),
 state TEXT NOT NULL DEFAULT 'armed' CHECK(state IN ('armed','sent','rejected')),
 sent_at_ms INTEGER,
 last_attempt_at_ms INTEGER
) STRICT;

INSERT INTO sql_assertions(scope,accepted)
 SELECT 'billing_collection_migration',CASE WHEN
 NOT EXISTS(SELECT 1 FROM billing_collection_arms a LEFT JOIN billing_collection_outbox o ON o.attempt_id=a.attempt_id WHERE o.attempt_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM billing_collection_outbox o LEFT JOIN billing_collection_arms a ON a.attempt_id=o.attempt_id WHERE a.attempt_id IS NULL)
 THEN 1 ELSE 0 END
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO billing_collection_work(attempt_id,state,sent_at_ms,last_attempt_at_ms)
 SELECT a.attempt_id,a.state,a.sent_at_ms,o.last_attempt_at_ms FROM billing_collection_arms a JOIN billing_collection_outbox o ON o.attempt_id=a.attempt_id;

DROP TRIGGER IF EXISTS billing_attempt_arms_collection;

DROP TRIGGER IF EXISTS billing_no_charge_requires_sent_arm;

DROP TRIGGER IF EXISTS billing_renewal_success_fence;

DROP TRIGGER IF EXISTS subscription_cancellation_fence;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_arms_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_arms_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_arms_delete;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_billing_collection_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_collection_arms_delete;

DROP TRIGGER IF EXISTS erasure_preserve_billing_collection_outbox_delete;

DROP TRIGGER IF EXISTS billing_attempt_user_collection_guard;

DROP TRIGGER IF EXISTS billing_checkout_response_guard;

DROP TABLE billing_collection_arms;

DROP TABLE billing_collection_outbox;

DELETE FROM sql_assertions WHERE scope='billing_collection_migration';

CREATE INDEX billing_collection_work_due ON billing_collection_work(last_attempt_at_ms,attempt_id) WHERE state='armed';

CREATE TRIGGER billing_attempt_arms_collection AFTER INSERT ON billing_attempts
BEGIN
  INSERT INTO billing_collection_work (attempt_id) VALUES (NEW.id);
END;

CREATE TRIGGER billing_no_charge_requires_sent_arm BEFORE INSERT ON billing_no_charge_confirmations
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts AS a
  JOIN billing_collection_work AS arm ON arm.attempt_id = a.id
  WHERE a.id = NEW.attempt_id AND a.wompi_reference = NEW.wompi_reference
    AND a.wompi_environment = NEW.wompi_environment AND a.status <> 'succeeded'
    AND arm.state = 'sent')
BEGIN SELECT RAISE(ABORT, 'billing_no_charge_unverified_arm'); END;

CREATE TRIGGER billing_renewal_success_fence AFTER INSERT ON billing_paid_periods
BEGIN
  UPDATE billing_collection_work SET state='rejected' WHERE state='armed' AND attempt_id<>NEW.attempt_id
    AND attempt_id IN (SELECT sibling.id FROM billing_attempts sibling JOIN billing_attempts success
      ON success.previous_paid_attempt_id=sibling.previous_paid_attempt_id WHERE success.id=NEW.attempt_id
      AND success.previous_paid_attempt_id IS NOT NULL);
END;

CREATE TRIGGER subscription_cancellation_fence AFTER INSERT ON subscription_cancellations
BEGIN
  DELETE FROM billing_followup_outbox WHERE attempt_id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
  UPDATE billing_collection_work SET state='rejected' WHERE state='armed'
    AND attempt_id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.user_id);
END;

CREATE TRIGGER erasure_fence_billing_collection_work_insert BEFORE INSERT ON billing_collection_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_collection_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_collection_work_update BEFORE UPDATE ON billing_collection_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_collection_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_collection_work_delete BEFORE DELETE ON billing_collection_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_collection_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_billing_collection_work_delete BEFORE DELETE ON billing_collection_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_collection_work','drain:'||lower(hex(randomblob(16))),json_object('last_attempt_at_ms',OLD.last_attempt_at_ms,'attempt_id',OLD."attempt_id",'state',OLD."state",'sent_at_ms',OLD."sent_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempts AS prior
  WHERE prior.user_id=NEW.user_id
    AND (prior.status='pending' OR (prior.status='failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_collection_work stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempts success
        JOIN billing_paid_periods paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN SELECT RAISE(ABORT, 'billing_user_collection_unresolved'); END;

CREATE TRIGGER billing_checkout_response_guard BEFORE INSERT ON billing_checkout_responses
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN billing_collection_work arm ON arm.attempt_id=a.id
  JOIN billing_transaction_candidates candidate ON candidate.attempt_id=a.id
  JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.attempt_id AND candidate.transaction_id=NEW.transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'billing_checkout_response_invalid'); END;
