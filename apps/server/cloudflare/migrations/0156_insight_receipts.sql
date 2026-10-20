PRAGMA defer_foreign_keys=ON;

DROP TRIGGER insight_delivery_attempts_no_update;

DROP TRIGGER insight_delivery_attempts_no_delete;

DROP TRIGGER erasure_fence_insight_delivery_attempts_insert;

DROP TRIGGER erasure_fence_insight_delivery_attempts_update;

DROP TRIGGER erasure_fence_insight_delivery_attempts_delete;

DROP TRIGGER erasure_preserve_insight_delivery_attempts_delete;

DROP TRIGGER insight_events_immutable;

DROP TRIGGER erasure_fence_insight_events_update;

ALTER TABLE insight_events ADD COLUMN delivery_receipt_id TEXT;

ALTER TABLE insight_events ADD COLUMN delivery_sent_at TEXT;

ALTER TABLE insight_events ADD COLUMN delivery_channel TEXT;

ALTER TABLE insight_events ADD COLUMN delivery_provider TEXT;

ALTER TABLE insight_events ADD COLUMN delivery_provider_message_id TEXT CHECK((delivery_receipt_id IS NULL AND delivery_sent_at IS NULL AND delivery_channel IS NULL AND delivery_provider IS NULL AND delivery_provider_message_id IS NULL) OR (delivery_receipt_id IS NOT NULL AND delivery_sent_at IS NOT NULL AND delivery_channel IS NOT NULL AND delivery_provider IS NOT NULL AND delivery_provider_message_id IS NOT NULL));

UPDATE insight_events SET delivery_receipt_id=d.id,delivery_sent_at=d.sent_at,delivery_channel=d.channel,delivery_provider=d.provider,delivery_provider_message_id=d.provider_message_id FROM insight_delivery_attempts d WHERE d.user_id=insight_events.user_id AND d.insight_event_id=insight_events.id;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_insight_receipts',((SELECT count(*) FROM insight_delivery_attempts)=(SELECT count(*) FROM insight_events WHERE delivery_receipt_id IS NOT NULL)) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE insight_delivery_attempts;

CREATE UNIQUE INDEX insight_events_delivery_receipt ON insight_events(delivery_receipt_id) WHERE delivery_receipt_id IS NOT NULL;

CREATE TRIGGER erasure_fence_insight_events_update BEFORE UPDATE ON insight_events
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.schedule_version IS NOT OLD.schedule_version OR NEW.service_market IS NOT OLD.service_market OR NEW.locale IS NOT OLD.locale OR NEW.time_zone IS NOT OLD.time_zone OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.money_groups_json IS NOT OLD.money_groups_json OR NEW.lifecycle_state IS NOT OLD.lifecycle_state) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed')
    OR (NEW.lifecycle_state=OLD.lifecycle_state AND (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id)))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;

CREATE TRIGGER insight_delivery_attempts_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_delivery_attempts_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_delivery_attempts_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_delivery_attempts_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NEW.delivery_receipt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER insight_delivery_attempts_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER insight_delivery_receipt_immutable BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND NOT((NEW.delivery_receipt_id IS NULL AND NEW.delivery_sent_at IS NULL AND NEW.delivery_channel IS NULL AND NEW.delivery_provider IS NULL AND NEW.delivery_provider_message_id IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;

CREATE TRIGGER insight_delivery_receipt_no_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
