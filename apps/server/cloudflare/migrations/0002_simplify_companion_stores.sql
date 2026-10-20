-- Preserve the deployed baseline; apply this bounded companion-store upgrade once.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP INDEX "budget_crossing_publication_due";
--> statement-breakpoint

DROP INDEX "budget_first_offer_due";
--> statement-breakpoint

DROP INDEX "budget_work_due";
--> statement-breakpoint

DROP INDEX "insight_events_budget_occurrence";
--> statement-breakpoint

DROP INDEX "insight_events_delivery_receipt";
--> statement-breakpoint

DROP INDEX "insight_events_due";
--> statement-breakpoint

DROP INDEX "insight_events_pending";
--> statement-breakpoint

DROP TRIGGER "audit_entries_no_delete";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_requires_claim";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_fence_delete";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_fence_insert";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_fence_update";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "budget_capture_work";
--> statement-breakpoint

DROP TRIGGER "budget_correction_work";
--> statement-breakpoint

DROP TRIGGER "budget_created_work";
--> statement-breakpoint

DROP TRIGGER "budget_first_creation_capture";
--> statement-breakpoint

DROP TRIGGER "budget_group_currency_version_insert";
--> statement-breakpoint

DROP TRIGGER "budget_group_currency_version_update";
--> statement-breakpoint

DROP TRIGGER "budget_link_work";
--> statement-breakpoint

DROP TRIGGER "budget_occurrence_frozen";
--> statement-breakpoint

DROP TRIGGER "budget_occurrence_no_delete";
--> statement-breakpoint

DROP TRIGGER "budget_removed_version";
--> statement-breakpoint

DROP TRIGGER "budget_revised_work";
--> statement-breakpoint

DROP TRIGGER "budget_state_kind_immutable";
--> statement-breakpoint

DROP TRIGGER "budget_unlink_work";
--> statement-breakpoint

DROP TRIGGER "budget_work_version_insert";
--> statement-breakpoint

DROP TRIGGER "budget_work_version_update";
--> statement-breakpoint

DROP TRIGGER "card_source_immutable";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_retention_permits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_retention_permits_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_retention_permits_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_browser_pairing_email_user_limits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_browser_pairing_email_user_limits_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_browser_pairing_email_user_limits_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_crossing_publications_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_crossing_publications_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_crossing_publications_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_reconciliation_work_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_reconciliation_work_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_reconciliation_work_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_user_versions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_user_versions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_user_versions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_email_replacement_limits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_email_replacement_limits_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_email_replacement_limits_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_events_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_events_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactive_transcript_event_links_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactive_transcript_event_links_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactive_transcript_event_links_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_message_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_message_events_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_message_events_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_subscriptions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_subscriptions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_subscriptions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_retention_permits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_crossing_publications_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_reconciliation_work_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_user_versions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_insight_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactive_transcript_event_links_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactivity_message_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_subscriptions_delete";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_fence_delete";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_fence_insert";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_fence_update";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_receipt_immutable";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_receipt_no_delete";
--> statement-breakpoint

DROP TRIGGER "insight_events_immutable";
--> statement-breakpoint

DROP TRIGGER "proactive_primary_link";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_guard";
--> statement-breakpoint

DROP TRIGGER "weekly_price_notice";
--> statement-breakpoint

ALTER TABLE users ADD COLUMN audit_retention_cutoff_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN paid_attempt_id TEXT REFERENCES billing_attempts(id);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN paid_price_id TEXT REFERENCES subscription_prices(id);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN paid_period_ends_at_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN paid_renewal_anchor_ms INTEGER CHECK((paid_attempt_id IS NULL AND paid_price_id IS NULL AND paid_period_ends_at_ms IS NULL AND paid_renewal_anchor_ms IS NULL) OR (paid_attempt_id IS NOT NULL AND paid_price_id IS NOT NULL AND paid_period_ends_at_ms IS NOT NULL AND paid_renewal_anchor_ms IS NOT NULL));
--> statement-breakpoint

CREATE UNIQUE INDEX users_paid_attempt ON users(paid_attempt_id) WHERE paid_attempt_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE email_security_limits(kind TEXT NOT NULL CHECK(kind IN ('pairing','replacement')),user_id TEXT NOT NULL REFERENCES users(id),window_started_at_ms INTEGER NOT NULL,requests INTEGER NOT NULL CHECK(requests BETWEEN 1 AND 5),last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),CHECK((kind='pairing' AND last_work_id IS NULL) OR(kind='replacement' AND last_work_id IS NOT NULL)),PRIMARY KEY(kind,user_id)) STRICT;
--> statement-breakpoint

ALTER TABLE operational_health_view ADD COLUMN last_succeeded_ms INTEGER CHECK(last_succeeded_ms IS NULL OR (last_succeeded_ms>=0 AND operation IN ('queueExecution','workflowExecution')));
--> statement-breakpoint

CREATE TABLE _next_budget_state (
 kind TEXT NOT NULL CHECK(kind IN ('user','work','publication')),user_id TEXT NOT NULL REFERENCES users(id),occurred_at TEXT NOT NULL DEFAULT '',
 record_id TEXT NOT NULL DEFAULT '',detected_at_ms INTEGER,materialized_at_ms INTEGER,
 revision INTEGER CHECK(revision>=1),budget_id TEXT,created_at_ms INTEGER,offer_requested_at_ms INTEGER,first_last_evaluated_at_ms INTEGER,
 version INTEGER DEFAULT 1,last_evaluated_at_ms INTEGER DEFAULT 0,
 PRIMARY KEY(kind,user_id,occurred_at,record_id),
 CHECK((kind='user' AND record_id='' AND detected_at_ms IS NULL AND materialized_at_ms IS NULL AND occurred_at='' AND version IS NULL AND last_evaluated_at_ms IS NULL
   AND ((budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL)
    OR(budget_id IS NOT NULL AND created_at_ms IS NOT NULL AND first_last_evaluated_at_ms IS NOT NULL) OR (kind='publication' AND occurred_at='' AND record_id<>'' AND detected_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND version IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL)))
 OR(kind='work' AND record_id='' AND detected_at_ms IS NULL AND materialized_at_ms IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL
   AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL AND version IS NOT NULL AND last_evaluated_at_ms IS NOT NULL) OR (kind='publication' AND occurred_at='' AND record_id<>'' AND detected_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND version IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO _next_budget_state(kind,user_id,occurred_at,revision,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) SELECT kind,user_id,occurred_at,revision,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms FROM budget_state;
--> statement-breakpoint

DROP TABLE budget_state;
--> statement-breakpoint

ALTER TABLE _next_budget_state RENAME TO budget_state;
--> statement-breakpoint

CREATE TABLE _next_insight_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version > 0),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  money_groups_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'delivered', 'read', 'dismissed')), delivery_receipt_id TEXT, delivery_sent_at TEXT, delivery_channel TEXT, delivery_provider TEXT, delivery_provider_message_id TEXT CHECK((delivery_receipt_id IS NULL AND delivery_sent_at IS NULL AND delivery_channel IS NULL AND delivery_provider IS NULL AND delivery_provider_message_id IS NULL) OR (delivery_receipt_id IS NOT NULL AND delivery_sent_at IS NOT NULL AND delivery_channel IS NOT NULL AND delivery_provider IS NOT NULL AND delivery_provider_message_id IS NOT NULL)), budget_delivery_group_id TEXT, budget_threshold INTEGER CHECK(budget_threshold IS NULL OR budget_threshold IN(80,100)), budget_crossing_json TEXT CHECK(budget_crossing_json IS NULL OR json_valid(budget_crossing_json)) CHECK((budget_delivery_group_id IS NULL AND budget_threshold IS NULL AND budget_crossing_json IS NULL) OR (budget_delivery_group_id IS NOT NULL AND budget_threshold IS NOT NULL AND budget_crossing_json IS NOT NULL)),
  report_delivery_id TEXT, transcript_id TEXT, transcript_kind TEXT CHECK(transcript_kind IS NULL OR transcript_kind='insight'),
  CHECK((transcript_id IS NULL)=(transcript_kind IS NULL)),
  FOREIGN KEY(user_id,report_delivery_id) REFERENCES insight_reports(user_id,proactivity_reference),
  FOREIGN KEY(user_id,transcript_kind,transcript_id) REFERENCES proactive_transcript_entries(user_id,kind,id),
  UNIQUE(user_id, schedule_id, schedule_version, scheduled_at),
  UNIQUE(user_id, id)
) STRICT;
--> statement-breakpoint

INSERT INTO _next_insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json) SELECT id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json FROM insight_events;
--> statement-breakpoint

DROP TABLE insight_events;
--> statement-breakpoint

ALTER TABLE _next_insight_events RENAME TO insight_events;
--> statement-breakpoint

CREATE TABLE _next_operational_event_buckets (
  kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'tail_overflow', 'worker_exception', 'resource_limit', 'callback_rejection', 'workflow_failure', 'core_rejection')),
  bucket_ms INTEGER NOT NULL CHECK (bucket_ms >= 0 AND bucket_ms % 60000 = 0),
  observed_at_ms INTEGER CHECK(observed_at_ms IS NULL OR(observed_at_ms>=0 AND observed_at_ms%60000=0)),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 1000),
  CHECK((kind='core_rejection' AND bucket_ms=0 AND count=1 AND observed_at_ms IS NOT NULL) OR(kind<>'core_rejection' AND observed_at_ms IS NULL)),PRIMARY KEY (kind, bucket_ms)
) STRICT;
--> statement-breakpoint

INSERT INTO _next_operational_event_buckets(kind,bucket_ms,count) SELECT kind,bucket_ms,count FROM operational_event_buckets;
--> statement-breakpoint

DROP TABLE operational_event_buckets;
--> statement-breakpoint

ALTER TABLE _next_operational_event_buckets RENAME TO operational_event_buckets;
--> statement-breakpoint

UPDATE users SET audit_retention_cutoff_ms=(SELECT cutoff_ms FROM audit_retention_permits WHERE user_id=users.id);
--> statement-breakpoint

UPDATE users SET (paid_attempt_id,paid_price_id,paid_period_ends_at_ms,paid_renewal_anchor_ms)=(SELECT attempt_id,price_id,paid_period_ends_at_ms,renewal_anchor_ms FROM subscriptions WHERE user_id=users.id);
--> statement-breakpoint

INSERT INTO budget_state(kind,user_id,record_id,detected_at_ms,materialized_at_ms,last_evaluated_at_ms,version) SELECT 'publication',user_id,delivery_group_id,detected_at_ms,materialized_at_ms,last_evaluated_at_ms,NULL FROM budget_crossing_publications;
--> statement-breakpoint

UPDATE insight_events SET report_delivery_id=(SELECT delivery_id FROM proactivity_message_events l WHERE l.user_id=insight_events.user_id AND l.insight_event_id=insight_events.id);
--> statement-breakpoint

UPDATE insight_events SET (transcript_id,transcript_kind)=(SELECT transcript_id,transcript_kind FROM proactive_transcript_event_links l WHERE l.user_id=insight_events.user_id AND l.insight_event_id=insight_events.id);
--> statement-breakpoint

INSERT INTO email_security_limits SELECT 'pairing',user_id,window_started_at_ms,requests,NULL FROM browser_pairing_email_user_limits;
--> statement-breakpoint

INSERT INTO email_security_limits SELECT 'replacement',user_id,window_started_at_ms,requests,last_work_id FROM email_replacement_limits;
--> statement-breakpoint

INSERT INTO operational_health_view(operation,state,observed_at_ms,last_succeeded_ms) SELECT kind,'healthy',last_succeeded_ms,last_succeeded_ms FROM operational_canary WHERE true ON CONFLICT(operation) DO UPDATE SET last_succeeded_ms=excluded.last_succeeded_ms;
--> statement-breakpoint

INSERT INTO operational_event_buckets(kind,bucket_ms,count,observed_at_ms) SELECT 'core_rejection',0,1,observed_at_ms FROM operational_core_rejection_burst;
--> statement-breakpoint

DROP TABLE audit_retention_permits;
--> statement-breakpoint

DROP TABLE browser_pairing_email_user_limits;
--> statement-breakpoint

DROP TABLE budget_crossing_publications;
--> statement-breakpoint

DROP TABLE email_replacement_limits;
--> statement-breakpoint

DROP TABLE operational_canary;
--> statement-breakpoint

DROP TABLE operational_core_rejection_burst;
--> statement-breakpoint

DROP TABLE proactive_transcript_event_links;
--> statement-breakpoint

DROP TABLE proactivity_message_events;
--> statement-breakpoint

DROP TABLE subscriptions;
--> statement-breakpoint

CREATE TRIGGER weekly_price_notice AFTER UPDATE OF published_order ON subscription_prices
WHEN NEW.published_order = 1 AND OLD.published_order IS NULL
BEGIN
 INSERT OR IGNORE INTO billing_price_notices (user_id, price_id, created_at_ms)
    SELECT s.user_id, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) s
    JOIN billing_attempts a ON a.id=s.attempt_id AND a.user_id=s.user_id
    JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=s.user_id
    WHERE a.billing_period='weekly' AND source.method='card' AND a.price_id<>NEW.id
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) stop WHERE stop.user_id=s.user_id);
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard BEFORE INSERT ON subscription_cancellations
WHEN NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.user_id AND a.id=NEW.paid_attempt_id AND a.payment_source_id=NEW.payment_source_id
 AND NEW.paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER proactive_primary_link AFTER INSERT ON proactive_transcript_entries WHEN NEW.kind='insight' BEGIN UPDATE insight_events SET transcript_id=NEW.id,transcript_kind='insight' WHERE user_id=NEW.user_id AND id=NEW.insight_event_id AND transcript_id IS NULL; END;
--> statement-breakpoint

CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed')
    OR (NEW.lifecycle_state=OLD.lifecycle_state AND ((NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) OR NEW.report_delivery_id IS NOT OLD.report_delivery_id OR NEW.transcript_id IS NOT OLD.transcript_id OR NEW.transcript_kind IS NOT OLD.transcript_kind OR NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id)))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_receipt_no_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_receipt_immutable BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND NOT((NEW.delivery_receipt_id IS NULL AND NEW.delivery_sent_at IS NULL AND NEW.delivery_channel IS NULL AND NEW.delivery_provider IS NULL AND NEW.delivery_provider_message_id IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NEW.delivery_receipt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_events','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'scheduled_at',OLD."scheduled_at",'money_groups_json',OLD."money_groups_json",'lifecycle_state',OLD."lifecycle_state")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_user_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'budget_id',OLD.budget_id,'created_at_ms',OLD.created_at_ms,'offer_requested_at_ms',OLD.offer_requested_at_ms,'first_last_evaluated_at_ms',OLD.first_last_evaluated_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_reconciliation_work','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'occurred_at',OLD."occurred_at",'version',OLD."version",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_update BEFORE UPDATE ON insight_events
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.schedule_version IS NOT OLD.schedule_version OR NEW.service_market IS NOT OLD.service_market OR NEW.locale IS NOT OLD.locale OR NEW.time_zone IS NOT OLD.time_zone OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.money_groups_json IS NOT OLD.money_groups_json OR NEW.lifecycle_state IS NOT OLD.lifecycle_state) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_insert BEFORE INSERT ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_payment_sources
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.enrollment_id<>OLD.enrollment_id
  OR NEW.wompi_source_id<>OLD.wompi_source_id OR NEW.billing_email<>OLD.billing_email
  OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.method<>OLD.method
  OR OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL
  OR OLD.method<>'card'
  OR NOT EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id)
  OR EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub WHERE sub.user_id=OLD.user_id)
  OR EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id
    AND (a.status<>'failed'
      OR EXISTS (SELECT 1 FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status IN ('PENDING','APPROVED'))
      OR (NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=a.id)
        AND NOT (a.no_charge_confirmed_at_ms IS NOT NULL AND a.no_charge_reference=a.wompi_reference AND a.no_charge_environment=a.wompi_environment))))
BEGIN
 SELECT RAISE(ABORT, 'card_source_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER budget_work_version_update AFTER UPDATE ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1; END;
--> statement-breakpoint

CREATE TRIGGER budget_work_version_insert AFTER INSERT ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1; END;
--> statement-breakpoint

CREATE TRIGGER budget_unlink_work AFTER UPDATE ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_state_kind_immutable BEFORE UPDATE OF kind ON budget_state WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'budget_state_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_revised_work AFTER UPDATE ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_removed_version AFTER DELETE ON budgets
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='budgets' AND (OLD.user_id=q.user_id))
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',OLD.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
  DELETE FROM budget_state WHERE kind='work' AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM budgets WHERE user_id = OLD.user_id); END;
--> statement-breakpoint

CREATE TRIGGER budget_occurrence_no_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_occurrence_frozen BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND NOT((NEW.budget_delivery_group_id IS NULL AND NEW.budget_threshold IS NULL AND NEW.budget_crossing_json IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_link_work AFTER INSERT ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_update AFTER UPDATE ON budget_group_currencies
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_insert AFTER INSERT ON budget_group_currencies
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_first_creation_capture AFTER INSERT ON budgets
BEGIN
 INSERT INTO budget_state(kind,user_id,budget_id,created_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,NEW.id,CAST(unixepoch(NEW.created_at)*1000 AS INTEGER),0,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET budget_id=excluded.budget_id,created_at_ms=excluded.created_at_ms,first_last_evaluated_at_ms=0 WHERE budget_state.budget_id IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER budget_created_work AFTER INSERT ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_correction_work AFTER UPDATE ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1;
  INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',OLD.user_id, OLD.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_capture_work AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NEW.budget_delivery_group_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

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
  SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub
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
      JOIN (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub ON sub.attempt_id = first.previous_paid_attempt_id AND sub.user_id = first.user_id
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
--> statement-breakpoint

CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
WHEN OLD.record_type IN ('session_call','credential_call','insight_call','publication')
 AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS user_id,audit_retention_cutoff_ms AS cutoff_ms FROM users WHERE audit_retention_cutoff_ms IS NOT NULL) WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms
 )
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
  WHERE p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id
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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 END
 )
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
--> statement-breakpoint

CREATE INDEX insight_events_pending ON insight_events(user_id, lifecycle_state, scheduled_at, id);
--> statement-breakpoint

CREATE INDEX insight_events_due ON insight_events(lifecycle_state, scheduled_at, id);
--> statement-breakpoint

CREATE UNIQUE INDEX insight_events_delivery_receipt ON insight_events(delivery_receipt_id) WHERE delivery_receipt_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_events_budget_occurrence ON insight_events(user_id,budget_delivery_group_id,budget_threshold) WHERE budget_delivery_group_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX budget_work_due ON budget_state(last_evaluated_at_ms,user_id,occurred_at) WHERE kind='work';
--> statement-breakpoint

CREATE INDEX budget_first_offer_due ON budget_state(first_last_evaluated_at_ms,user_id) WHERE kind='user' AND budget_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_delete BEFORE DELETE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_insert BEFORE INSERT ON users WHEN (NEW.audit_retention_cutoff_ms IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_update BEFORE UPDATE ON users WHEN ((NEW.id IS NOT OLD.id OR NEW.audit_retention_cutoff_ms IS NOT OLD.audit_retention_cutoff_ms) AND (OLD.audit_retention_cutoff_ms IS NOT NULL OR NEW.audit_retention_cutoff_ms IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_retention_permits_delete BEFORE DELETE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'audit_retention_permits','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'cutoff_ms',OLD.audit_retention_cutoff_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_retention_permits_delete_clear BEFORE UPDATE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND NEW.audit_retention_cutoff_ms IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'audit_retention_permits','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'cutoff_ms',OLD.audit_retention_cutoff_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_delete BEFORE DELETE ON users WHEN (OLD.paid_attempt_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_insert BEFORE INSERT ON users WHEN (NEW.paid_attempt_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_update BEFORE UPDATE ON users WHEN ((NEW.paid_renewal_anchor_ms IS NOT OLD.paid_renewal_anchor_ms OR NEW.paid_attempt_id IS NOT OLD.paid_attempt_id OR NEW.paid_price_id IS NOT OLD.paid_price_id OR NEW.id IS NOT OLD.id OR NEW.paid_period_ends_at_ms IS NOT OLD.paid_period_ends_at_ms) AND (OLD.paid_attempt_id IS NOT NULL OR NEW.paid_attempt_id IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscriptions_delete BEFORE DELETE ON users WHEN (OLD.paid_attempt_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscriptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'attempt_id',OLD.paid_attempt_id,'price_id',OLD.paid_price_id,'paid_period_ends_at_ms',OLD.paid_period_ends_at_ms,'renewal_anchor_ms',OLD.paid_renewal_anchor_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscriptions_delete_clear BEFORE UPDATE ON users WHEN (OLD.paid_attempt_id IS NOT NULL) AND NEW.paid_attempt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscriptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'attempt_id',OLD.paid_attempt_id,'price_id',OLD.paid_price_id,'paid_period_ends_at_ms',OLD.paid_period_ends_at_ms,'renewal_anchor_ms',OLD.paid_renewal_anchor_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_delete BEFORE DELETE ON budget_state WHEN (OLD.kind='publication') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_insert BEFORE INSERT ON budget_state WHEN (NEW.kind='publication') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_update BEFORE UPDATE ON budget_state WHEN ((NEW.materialized_at_ms IS NOT OLD.materialized_at_ms OR NEW.user_id IS NOT OLD.user_id OR NEW.last_evaluated_at_ms IS NOT OLD.last_evaluated_at_ms OR NEW.detected_at_ms IS NOT OLD.detected_at_ms OR NEW.kind IS NOT OLD.kind OR NEW.record_id IS NOT OLD.record_id) AND (OLD.kind='publication' OR NEW.kind='publication')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_crossing_publications_delete BEFORE DELETE ON budget_state WHEN (OLD.kind='publication') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_crossing_publications','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.record_id,'detected_at_ms',OLD.detected_at_ms,'materialized_at_ms',OLD.materialized_at_ms,'last_evaluated_at_ms',OLD.last_evaluated_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE INDEX budget_publication_due ON budget_state(user_id,detected_at_ms,record_id) WHERE kind='publication' AND materialized_at_ms IS NULL;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_delete BEFORE DELETE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_insert BEFORE INSERT ON insight_events WHEN (NEW.report_delivery_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_update BEFORE UPDATE ON insight_events WHEN ((NEW.id IS NOT OLD.id OR NEW.report_delivery_id IS NOT OLD.report_delivery_id) AND (OLD.report_delivery_id IS NOT NULL OR NEW.report_delivery_id IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete BEFORE DELETE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete_clear BEFORE UPDATE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND NEW.report_delivery_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_delete BEFORE DELETE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_insert BEFORE INSERT ON insight_events WHEN (NEW.transcript_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_update BEFORE UPDATE ON insight_events WHEN ((NEW.id IS NOT OLD.id OR NEW.transcript_id IS NOT OLD.transcript_id OR NEW.transcript_kind IS NOT OLD.transcript_kind) AND (OLD.transcript_id IS NOT NULL OR NEW.transcript_id IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete BEFORE DELETE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('transcript_kind',OLD.transcript_kind,'user_id',OLD.user_id,'transcript_id',OLD.transcript_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete_clear BEFORE UPDATE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND NEW.transcript_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('transcript_kind',OLD.transcript_kind,'user_id',OLD.user_id,'transcript_id',OLD.transcript_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE INDEX insight_event_report ON insight_events(user_id,report_delivery_id) WHERE report_delivery_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_event_transcript ON insight_events(user_id,transcript_kind,transcript_id) WHERE transcript_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER proactive_transcript_clear_links BEFORE DELETE ON proactive_transcript_entries WHEN OLD.kind='insight' BEGIN UPDATE insight_events SET transcript_id=NULL,transcript_kind=NULL WHERE user_id=OLD.user_id AND transcript_kind=OLD.kind AND transcript_id=OLD.id; END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_delete BEFORE DELETE ON email_security_limits WHEN (OLD.kind='pairing') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_insert BEFORE INSERT ON email_security_limits WHEN (NEW.kind='pairing') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_update BEFORE UPDATE ON email_security_limits WHEN ((NEW.user_id IS NOT OLD.user_id OR NEW.requests IS NOT OLD.requests OR NEW.window_started_at_ms IS NOT OLD.window_started_at_ms OR NEW.kind IS NOT OLD.kind) AND (OLD.kind='pairing' OR NEW.kind='pairing')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_delete BEFORE DELETE ON email_security_limits WHEN (OLD.kind='replacement') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_insert BEFORE INSERT ON email_security_limits WHEN (NEW.kind='replacement') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_update BEFORE UPDATE ON email_security_limits WHEN ((NEW.user_id IS NOT OLD.user_id OR NEW.last_work_id IS NOT OLD.last_work_id OR NEW.requests IS NOT OLD.requests OR NEW.window_started_at_ms IS NOT OLD.window_started_at_ms OR NEW.kind IS NOT OLD.kind) AND (OLD.kind='replacement' OR NEW.kind='replacement')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE VIEW subscription_standing AS SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL;
--> statement-breakpoint

-- Rebuilt parents can leave deferred violation counters after their rows are restored.
-- Verify every relationship before clearing those counters and committing.
CREATE TABLE _companion_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _companion_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _companion_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
