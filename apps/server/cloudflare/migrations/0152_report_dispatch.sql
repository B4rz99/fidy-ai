PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_delivery_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_delivery_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_delivery_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_proactivity_delivery_outbox_delete;

DROP TRIGGER IF EXISTS insight_reports_immutable;

DROP TRIGGER IF EXISTS insight_reports_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_insight_reports_insert;

DROP TRIGGER IF EXISTS erasure_fence_insight_reports_update;

DROP TRIGGER IF EXISTS erasure_fence_insight_reports_delete;

DROP TRIGGER IF EXISTS erasure_preserve_insight_reports_delete;

DROP VIEW IF EXISTS proactivity_delivery_metadata;

ALTER TABLE insight_reports ADD COLUMN dispatch_state TEXT;

ALTER TABLE insight_reports ADD COLUMN dispatch_created_at_ms INTEGER;

ALTER TABLE insight_reports ADD COLUMN dispatch_last_attempt_at_ms INTEGER;

ALTER TABLE insight_reports ADD COLUMN dispatch_restart_attempts INTEGER CHECK((dispatch_state IS NULL AND dispatch_created_at_ms IS NULL AND dispatch_last_attempt_at_ms IS NULL AND dispatch_restart_attempts IS NULL) OR (dispatch_state IS NOT NULL AND (dispatch_state IN ('ready','started','settled','expired','refused')) AND dispatch_created_at_ms IS NOT NULL AND dispatch_last_attempt_at_ms IS NOT NULL AND dispatch_restart_attempts IS NOT NULL AND (dispatch_restart_attempts BETWEEN 0 AND 3))) CHECK(dispatch_state IS NULL OR dispatch_reference IS NOT NULL);

UPDATE insight_reports SET dispatch_state=(SELECT state FROM proactivity_delivery_outbox WHERE user_id=insight_reports.user_id AND kind=insight_reports.kind AND delivery_id=insight_reports.delivery_id),dispatch_created_at_ms=(SELECT created_at_ms FROM proactivity_delivery_outbox WHERE user_id=insight_reports.user_id AND kind=insight_reports.kind AND delivery_id=insight_reports.delivery_id),dispatch_last_attempt_at_ms=(SELECT last_attempt_at_ms FROM proactivity_delivery_outbox WHERE user_id=insight_reports.user_id AND kind=insight_reports.kind AND delivery_id=insight_reports.delivery_id),dispatch_restart_attempts=(SELECT restart_attempts FROM proactivity_delivery_outbox WHERE user_id=insight_reports.user_id AND kind=insight_reports.kind AND delivery_id=insight_reports.delivery_id);

DROP TABLE proactivity_delivery_outbox;

CREATE INDEX report_dispatch_due ON insight_reports(dispatch_state,dispatch_last_attempt_at_ms,dispatch_created_at_ms,kind,delivery_id,user_id) WHERE dispatch_state IS NOT NULL;

CREATE INDEX report_dispatch_health ON insight_reports(kind,dispatch_created_at_ms,user_id,delivery_id)
 WHERE dispatch_state IN ('ready','started') AND dispatch_state IS NOT NULL;

CREATE TRIGGER insight_reports_immutable BEFORE UPDATE ON insight_reports WHEN NOT(NEW.kind IS OLD.kind AND NEW.user_id IS OLD.user_id AND NEW.delivery_id IS OLD.delivery_id AND NEW.role IS OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms IS OLD.scheduled_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.payload_json IS OLD.payload_json AND NEW.presentation_json IS OLD.presentation_json AND NEW.reminder_grant_id IS OLD.reminder_grant_id AND NEW.reminder_expires_at_ms IS OLD.reminder_expires_at_ms AND NEW.instruction_id IS OLD.instruction_id AND NEW.instruction_version IS OLD.instruction_version AND NEW.grant_id IS OLD.grant_id AND NEW.local_date IS OLD.local_date AND NEW.day_from_ms IS OLD.day_from_ms AND NEW.day_to_ms IS OLD.day_to_ms AND NEW.report_json IS OLD.report_json AND (NEW.text IS OLD.text OR (OLD.kind='proactivity-delivery' AND OLD.text IS NOT NULL AND NEW.text IS NULL))) BEGIN SELECT RAISE(ABORT,'insight_report_immutable'); END;

CREATE TRIGGER insight_reports_no_delete BEFORE DELETE ON insight_reports
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_reports' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN
 SELECT RAISE(ABORT,'insight_report_immutable');
END;

CREATE TRIGGER erasure_fence_insight_reports_insert BEFORE INSERT ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_insight_reports_update BEFORE UPDATE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'insight_reports','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'delivery_id',OLD.delivery_id,'role',OLD.role,'consent_grant_id',OLD.consent_grant_id,'offer_id',OLD.offer_id,'text',OLD.text,'scheduled_at_ms',OLD.scheduled_at_ms,'expires_at_ms',OLD.expires_at_ms,'time_zone',OLD.time_zone,'created_at_ms',OLD.created_at_ms,'payload_json',OLD.payload_json,'presentation_json',OLD.presentation_json,'reminder_grant_id',OLD.reminder_grant_id,'reminder_expires_at_ms',OLD.reminder_expires_at_ms,'instruction_id',OLD.instruction_id,'instruction_version',OLD.instruction_version,'grant_id',OLD.grant_id,'local_date',OLD.local_date,'day_from_ms',OLD.day_from_ms,'day_to_ms',OLD.day_to_ms,'report_json',OLD.report_json,'dispatch_state',OLD.dispatch_state,'dispatch_created_at_ms',OLD.dispatch_created_at_ms,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'dispatch_restart_attempts',OLD.dispatch_restart_attempts) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE VIEW proactivity_delivery_metadata AS
 SELECT user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,
 dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts,expires_at_ms,
 (kind='weekly-summary' OR text IS NOT NULL) AS content_available
 FROM insight_reports WHERE dispatch_state IS NOT NULL;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_report_dispatch',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_report_dispatch';

PRAGMA defer_foreign_keys=OFF;
