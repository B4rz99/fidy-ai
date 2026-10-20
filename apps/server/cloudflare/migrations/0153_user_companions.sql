PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS dashboard_projection_new_user;

DROP TRIGGER IF EXISTS subscription_identity_immutable;

DROP TRIGGER IF EXISTS subscription_identity_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_email_forwarding_addresses_insert;

DROP TRIGGER IF EXISTS erasure_fence_email_forwarding_addresses_update;

DROP TRIGGER IF EXISTS erasure_fence_email_forwarding_addresses_delete;

DROP TRIGGER IF EXISTS erasure_fence_subscription_identities_insert;

DROP TRIGGER IF EXISTS erasure_fence_subscription_identities_update;

DROP TRIGGER IF EXISTS erasure_fence_subscription_identities_delete;

DROP TRIGGER IF EXISTS erasure_fence_users_insert;

DROP TRIGGER IF EXISTS erasure_fence_users_delete;

DROP TRIGGER IF EXISTS erasure_preserve_email_forwarding_addresses_delete;

DROP TRIGGER IF EXISTS erasure_preserve_subscription_identities_delete;

DROP TRIGGER IF EXISTS erasure_fence_users_update;

DROP TRIGGER IF EXISTS users_trial_immutable_update;

DROP TRIGGER IF EXISTS users_trial_immutable_delete;

DROP TRIGGER IF EXISTS issue_forwarding_address;

DROP TRIGGER IF EXISTS refund_acceptance_limit;

DROP TRIGGER IF EXISTS refund_snapshot_immutable;

DROP TRIGGER IF EXISTS refund_claim_requires_pending;

DROP TRIGGER IF EXISTS refund_claim_immutable;

DROP TRIGGER IF EXISTS refund_evidence_requires_claim;

DROP TRIGGER IF EXISTS refund_evidence_immutable;

DROP TRIGGER IF EXISTS refund_verified_settlement;

DROP TRIGGER IF EXISTS billing_access_adjustment_immutable;

DROP TRIGGER IF EXISTS subscription_renewal_stop_immutable;

DROP TRIGGER IF EXISTS billing_followup_refund_stop;

DROP TRIGGER IF EXISTS refund_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_insert;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_update;

DROP TRIGGER IF EXISTS erasure_fence_refund_attempts_delete;

DROP TRIGGER IF EXISTS erasure_preserve_refund_attempts_delete;

DROP TRIGGER IF EXISTS refund_reservation_guard;

DROP TRIGGER IF EXISTS weekly_price_notice;

DROP TRIGGER IF EXISTS billing_attempt_requires_claim;

DROP TRIGGER IF EXISTS subscription_cancellation_guard;

DROP TRIGGER IF EXISTS refund_companions_initial;

DROP VIEW IF EXISTS subscription_renewal_fences;

ALTER TABLE users ADD COLUMN subscription_id TEXT CHECK(subscription_id IS NULL OR length(subscription_id)=36);

ALTER TABLE users ADD COLUMN forwarding_address_id TEXT CHECK(forwarding_address_id IS NULL OR length(forwarding_address_id)=36);

ALTER TABLE users ADD COLUMN forwarding_local_part TEXT CHECK(forwarding_local_part IS NULL OR length(forwarding_local_part) BETWEEN 24 AND 64);

ALTER TABLE users ADD COLUMN forwarding_issued_at_ms INTEGER
 CHECK((forwarding_address_id IS NULL AND forwarding_local_part IS NULL AND forwarding_issued_at_ms IS NULL)
 OR (forwarding_address_id IS NOT NULL AND forwarding_local_part IS NOT NULL AND forwarding_issued_at_ms IS NOT NULL));

UPDATE users SET subscription_id=(SELECT id FROM subscription_identities WHERE user_id=users.id);

UPDATE users SET forwarding_address_id=(SELECT id FROM email_forwarding_addresses WHERE user_id=users.id),forwarding_local_part=(SELECT local_part FROM email_forwarding_addresses WHERE user_id=users.id),forwarding_issued_at_ms=(SELECT created_at_ms FROM email_forwarding_addresses WHERE user_id=users.id);

CREATE UNIQUE INDEX users_subscription_id ON users(subscription_id);

CREATE UNIQUE INDEX users_forwarding_address_id ON users(forwarding_address_id);

CREATE UNIQUE INDEX users_forwarding_local_part ON users(forwarding_local_part);

CREATE TABLE refund_attempts_new (
id TEXT PRIMARY KEY CHECK (length(id) = 36),
user_id TEXT NOT NULL REFERENCES users(id),
subscription_id TEXT NOT NULL REFERENCES users(subscription_id),
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

INSERT INTO refund_attempts_new(id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,work_version,dispatch_last_attempt_at_ms,published_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,adjusted_attempt_id,access_ends_at_ms,renewal_stopped_user_id,renewal_stopped_at_ms) SELECT id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,work_version,dispatch_last_attempt_at_ms,published_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,adjusted_attempt_id,access_ends_at_ms,renewal_stopped_user_id,renewal_stopped_at_ms FROM refund_attempts;

DROP TABLE refund_attempts;

ALTER TABLE refund_attempts_new RENAME TO refund_attempts;

CREATE INDEX refunds_by_charge ON refund_attempts(billing_attempt_id,status);

CREATE INDEX refunds_by_user ON refund_attempts(user_id,created_at_ms);

CREATE INDEX billing_access_by_period ON refund_attempts(adjusted_attempt_id,access_ends_at_ms) WHERE adjusted_attempt_id IS NOT NULL;

DROP TABLE subscription_identities;

DROP TABLE email_forwarding_addresses;

CREATE TRIGGER dashboard_projection_new_user AFTER INSERT ON users
BEGIN INSERT INTO dashboard_projection_state (user_id, version, readiness)
  VALUES (NEW.id, 1, 'ready'); END;

CREATE TRIGGER erasure_fence_users_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_users_delete BEFORE DELETE ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_users_update BEFORE UPDATE ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users')) AND NOT(NEW.id IS OLD.id AND NEW.service_market IS OLD.service_market AND NEW.locale IS OLD.locale AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.trial_started_at_ms IS OLD.trial_started_at_ms AND NEW.trial_ends_at_ms IS OLD.trial_ends_at_ms)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER users_trial_immutable_update BEFORE UPDATE OF trial_started_at_ms,trial_ends_at_ms ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND (NEW.trial_started_at_ms IS NOT OLD.trial_started_at_ms OR NEW.trial_ends_at_ms IS NOT OLD.trial_ends_at_ms)
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;

CREATE TRIGGER users_trial_immutable_delete BEFORE DELETE ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='users' AND p.user_id=OLD.id AND q.user_id=OLD.id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;

CREATE TRIGGER issue_forwarding_address AFTER INSERT ON consent_history WHEN NEW.record_type='processing_grant' BEGIN UPDATE users SET forwarding_address_id=lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-8' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),forwarding_local_part=lower(hex(randomblob(24))),forwarding_issued_at_ms=NEW.accepted_at_ms WHERE id=NEW.user_id AND forwarding_address_id IS NULL; END;

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

CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_attempts' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
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

CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN (SELECT rowid,id AS user_id,subscription_id AS id FROM users WHERE subscription_id IS NOT NULL) s ON s.user_id=a.user_id
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

CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.work_version IS NOT 1 OR NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.published_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.adjusted_attempt_id IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END;

CREATE TRIGGER subscription_identities_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER subscription_identities_field_fence_update BEFORE UPDATE ON users WHEN (NEW.subscription_id IS NOT OLD.subscription_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER subscription_identities_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER subscription_identities_field_preserve_update BEFORE UPDATE ON users
WHEN OLD.subscription_id IS NOT NULL AND NEW.subscription_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_identities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'id',OLD.subscription_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER subscription_identities_field_preserve_delete BEFORE DELETE ON users
WHEN OLD.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_identities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'id',OLD.subscription_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER subscription_identities_field_immutable BEFORE UPDATE ON users WHEN OLD.subscription_id IS NOT NULL AND (NEW.subscription_id IS NOT OLD.subscription_id) AND NOT((NEW.subscription_id IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='subscription_identities' AND p.user_id=OLD.id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'subscription_identities_immutable'); END;

CREATE TRIGGER email_forwarding_addresses_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.forwarding_address_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER email_forwarding_addresses_field_fence_update BEFORE UPDATE ON users WHEN (NEW.forwarding_address_id IS NOT OLD.forwarding_address_id OR NEW.forwarding_local_part IS NOT OLD.forwarding_local_part OR NEW.forwarding_issued_at_ms IS NOT OLD.forwarding_issued_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.forwarding_address_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.forwarding_address_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER email_forwarding_addresses_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.forwarding_address_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER email_forwarding_addresses_field_preserve_update BEFORE UPDATE ON users
WHEN OLD.forwarding_address_id IS NOT NULL AND NEW.forwarding_address_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'email_forwarding_addresses','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.forwarding_address_id,'user_id',OLD.id,'local_part',OLD.forwarding_local_part,'created_at_ms',OLD.forwarding_issued_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER email_forwarding_addresses_field_preserve_delete BEFORE DELETE ON users
WHEN OLD.forwarding_address_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'email_forwarding_addresses','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.forwarding_address_id,'user_id',OLD.id,'local_part',OLD.forwarding_local_part,'created_at_ms',OLD.forwarding_issued_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;


CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM subscription_cancellations;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_user_companions',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_user_companions';

PRAGMA defer_foreign_keys=OFF;
