PRAGMA defer_foreign_keys=ON;

DROP TRIGGER insight_events_immutable;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_budget_cardinality',NOT EXISTS(SELECT insight_event_id FROM budget_alert_occurrences GROUP BY user_id,insight_event_id HAVING count(*)>1) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TRIGGER budget_occurrence_frozen;

DROP TRIGGER erasure_fence_budget_alert_occurrences_insert;

DROP TRIGGER erasure_fence_budget_alert_occurrences_update;

DROP TRIGGER erasure_fence_budget_alert_occurrences_delete;

DROP TRIGGER erasure_preserve_budget_alert_occurrences_delete;

ALTER TABLE insight_events ADD COLUMN budget_delivery_group_id TEXT;

ALTER TABLE insight_events ADD COLUMN budget_threshold INTEGER CHECK(budget_threshold IS NULL OR budget_threshold IN(80,100));

ALTER TABLE insight_events ADD COLUMN budget_crossing_json TEXT CHECK(budget_crossing_json IS NULL OR json_valid(budget_crossing_json)) CHECK((budget_delivery_group_id IS NULL AND budget_threshold IS NULL AND budget_crossing_json IS NULL) OR (budget_delivery_group_id IS NOT NULL AND budget_threshold IS NOT NULL AND budget_crossing_json IS NOT NULL));

UPDATE insight_events SET (budget_delivery_group_id,budget_threshold,budget_crossing_json)=(SELECT delivery_group_id,threshold,crossing_json FROM budget_alert_occurrences WHERE user_id=insight_events.user_id AND insight_event_id=insight_events.id) WHERE EXISTS(SELECT 1 FROM budget_alert_occurrences WHERE user_id=insight_events.user_id AND insight_event_id=insight_events.id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_budget_occurrences',(SELECT count(*) FROM budget_alert_occurrences)=(SELECT count(*) FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE budget_alert_occurrences;

CREATE UNIQUE INDEX insight_events_budget_occurrence ON insight_events(user_id,budget_delivery_group_id,budget_threshold) WHERE budget_delivery_group_id IS NOT NULL;

CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed')
    OR (NEW.lifecycle_state=OLD.lifecycle_state AND ((NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) OR NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id)))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;

CREATE TRIGGER budget_alert_occurrences_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER budget_alert_occurrences_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER budget_alert_occurrences_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER budget_alert_occurrences_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NEW.budget_delivery_group_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER budget_alert_occurrences_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER budget_occurrence_frozen BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND NOT((NEW.budget_delivery_group_id IS NULL AND NEW.budget_threshold IS NULL AND NEW.budget_crossing_json IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;

CREATE TRIGGER budget_occurrence_no_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
