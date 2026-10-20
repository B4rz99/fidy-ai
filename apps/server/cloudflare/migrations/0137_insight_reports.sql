PRAGMA defer_foreign_keys=ON;

CREATE TABLE insight_reports (
 kind TEXT NOT NULL CHECK(kind IN ('weekly-summary','proactivity-delivery')),
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 role TEXT CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT,
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER,
 expires_at_ms INTEGER,
 time_zone TEXT,
 created_at_ms INTEGER,
 payload_json TEXT CHECK(json_valid(payload_json)),
 presentation_json TEXT CHECK(json_valid(presentation_json)),
 reminder_grant_id TEXT,
 reminder_expires_at_ms INTEGER,
 instruction_id TEXT,
 instruction_version INTEGER,
 grant_id TEXT,
 local_date TEXT,
 day_from_ms INTEGER,
 day_to_ms INTEGER,
 report_json TEXT CHECK(json_valid(report_json)),
 event_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='weekly-summary' OR reminder_grant_id IS NOT NULL OR report_json IS NOT NULL THEN delivery_id END) VIRTUAL,
 dispatch_reference TEXT GENERATED ALWAYS AS (CASE WHEN scheduled_at_ms IS NOT NULL THEN delivery_id END) VIRTUAL,
 proactivity_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL THEN delivery_id END) VIRTUAL,
 grant_history_type TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' THEN 'proactivity_grant' END) VIRTUAL,
 reminder_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL,
 PRIMARY KEY(user_id,kind,delivery_id),
 UNIQUE(user_id,kind,dispatch_reference),
 UNIQUE(user_id,proactivity_reference),
 FOREIGN KEY(user_id,event_reference) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(user_id,grant_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY(user_id,reminder_history_type,reminder_grant_id) REFERENCES consent_history(user_id,record_type,id),
 CHECK((reminder_grant_id IS NULL)=(reminder_expires_at_ms IS NULL)),
 CHECK((report_json IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL)
  OR (report_json IS NOT NULL AND instruction_id IS NOT NULL AND instruction_version IS NOT NULL AND grant_id IS NOT NULL AND local_date IS NOT NULL AND day_from_ms IS NOT NULL AND day_to_ms IS NOT NULL AND day_to_ms>day_from_ms)),
 CHECK((kind='weekly-summary' AND consent_grant_id IS NOT NULL AND payload_json IS NOT NULL AND presentation_json IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms>scheduled_at_ms AND expires_at_ms<=scheduled_at_ms+86400000 AND role IS NULL AND offer_id IS NULL AND text IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND reminder_grant_id IS NULL AND report_json IS NULL)
  OR (kind='proactivity-delivery' AND payload_json IS NULL AND presentation_json IS NULL AND
   ((scheduled_at_ms IS NOT NULL AND role IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND created_at_ms IS NOT NULL AND
    ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL)))
   OR (scheduled_at_ms IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND (reminder_grant_id IS NOT NULL OR report_json IS NOT NULL)))))
) STRICT;

INSERT INTO insight_reports(kind,user_id,delivery_id,consent_grant_id,payload_json,presentation_json,scheduled_at_ms,expires_at_ms) SELECT 'weekly-summary',user_id,insight_event_id,consent_grant_id,payload_json,presentation_json,scheduled_at_ms,expires_at_ms FROM weekly_summary_reports;

INSERT INTO insight_reports(kind,delivery_id,user_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT 'proactivity-delivery',delivery_id,user_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms FROM proactivity_reports;

INSERT INTO insight_reports(kind,user_id,delivery_id,reminder_grant_id,reminder_expires_at_ms)
SELECT 'proactivity-delivery',user_id,insight_event_id,consent_grant_id,expires_at_ms FROM reminder_occurrence_reports WHERE 1=1
ON CONFLICT(user_id,kind,delivery_id) DO UPDATE SET reminder_grant_id=excluded.reminder_grant_id,reminder_expires_at_ms=excluded.reminder_expires_at_ms;

INSERT INTO insight_reports(kind,user_id,delivery_id,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json) SELECT 'proactivity-delivery',user_id,insight_event_id,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json FROM recurring_digest_reports WHERE 1=1
ON CONFLICT(user_id,kind,delivery_id) DO UPDATE SET instruction_id=excluded.instruction_id,instruction_version=excluded.instruction_version,grant_id=excluded.grant_id,local_date=excluded.local_date,day_from_ms=excluded.day_from_ms,day_to_ms=excluded.day_to_ms,report_json=excluded.report_json;

DROP VIEW proactivity_delivery_metadata;

CREATE TABLE proactivity_delivery_outbox_consolidated (
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('weekly-summary','proactivity-delivery')),
 delivery_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','started','settled','expired','refused')),
 created_at_ms INTEGER NOT NULL,
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3),
 PRIMARY KEY(user_id,kind,delivery_id),
 FOREIGN KEY(user_id,kind,delivery_id) REFERENCES insight_reports(user_id,kind,dispatch_reference)
) STRICT;

INSERT INTO proactivity_delivery_outbox_consolidated(user_id,kind,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts) SELECT user_id,kind,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM proactivity_delivery_outbox;

DROP TRIGGER erasure_fence_proactivity_delivery_outbox_insert;

DROP TRIGGER erasure_fence_proactivity_delivery_outbox_update;

DROP TRIGGER erasure_fence_proactivity_delivery_outbox_delete;

DROP TRIGGER erasure_preserve_proactivity_delivery_outbox_delete;

DROP TABLE proactivity_delivery_outbox;

ALTER TABLE proactivity_delivery_outbox_consolidated RENAME TO proactivity_delivery_outbox;

CREATE INDEX proactivity_delivery_outbox_due ON proactivity_delivery_outbox(state,last_attempt_at_ms,created_at_ms,kind,delivery_id,user_id);

CREATE INDEX proactivity_delivery_outbox_health ON proactivity_delivery_outbox(kind,created_at_ms,user_id,delivery_id)
 WHERE state IN ('ready','started');

CREATE TRIGGER erasure_fence_proactivity_delivery_outbox_insert BEFORE INSERT ON proactivity_delivery_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_delivery_outbox'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_delivery_outbox_update BEFORE UPDATE ON proactivity_delivery_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_delivery_outbox'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_delivery_outbox_delete BEFORE DELETE ON proactivity_delivery_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_delivery_outbox'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_proactivity_delivery_outbox_delete BEFORE DELETE ON proactivity_delivery_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_delivery_outbox','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'created_at_ms',OLD."created_at_ms",'state',OLD."state",'last_attempt_at_ms',OLD."last_attempt_at_ms",'restart_attempts',OLD."restart_attempts")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TABLE proactivity_message_events_consolidated (
 user_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,delivery_id) REFERENCES insight_reports(user_id,proactivity_reference),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;

INSERT INTO proactivity_message_events_consolidated(user_id,delivery_id,insight_event_id) SELECT user_id,delivery_id,insight_event_id FROM proactivity_message_events;

DROP TRIGGER erasure_fence_proactivity_message_events_insert;

DROP TRIGGER erasure_fence_proactivity_message_events_update;

DROP TRIGGER erasure_fence_proactivity_message_events_delete;

DROP TRIGGER erasure_preserve_proactivity_message_events_delete;

DROP TABLE proactivity_message_events;

ALTER TABLE proactivity_message_events_consolidated RENAME TO proactivity_message_events;

CREATE TRIGGER erasure_fence_proactivity_message_events_insert BEFORE INSERT ON proactivity_message_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_message_events_update BEFORE UPDATE ON proactivity_message_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_message_events_delete BEFORE DELETE ON proactivity_message_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete BEFORE DELETE ON proactivity_message_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

DROP TRIGGER weekly_report_no_update;

DROP TRIGGER weekly_report_no_delete;

DROP TRIGGER erasure_fence_weekly_summary_reports_insert;

DROP TRIGGER erasure_fence_weekly_summary_reports_update;

DROP TRIGGER erasure_fence_weekly_summary_reports_delete;

DROP TRIGGER erasure_preserve_weekly_summary_reports_delete;

DROP TABLE weekly_summary_reports;

DROP TRIGGER proactivity_report_immutable;

DROP TRIGGER erasure_fence_proactivity_reports_insert;

DROP TRIGGER erasure_fence_proactivity_reports_update;

DROP TRIGGER erasure_fence_proactivity_reports_delete;

DROP TRIGGER erasure_preserve_proactivity_reports_delete;

DROP TABLE proactivity_reports;

DROP TRIGGER reminder_report_no_update;

DROP TRIGGER erasure_fence_reminder_occurrence_reports_insert;

DROP TRIGGER erasure_fence_reminder_occurrence_reports_update;

DROP TRIGGER erasure_fence_reminder_occurrence_reports_delete;

DROP TRIGGER erasure_preserve_reminder_occurrence_reports_delete;

DROP TABLE reminder_occurrence_reports;

DROP TRIGGER recurring_digest_report_immutable;

DROP TRIGGER erasure_fence_recurring_digest_reports_insert;

DROP TRIGGER erasure_fence_recurring_digest_reports_update;

DROP TRIGGER erasure_fence_recurring_digest_reports_delete;

DROP TRIGGER erasure_preserve_recurring_digest_reports_delete;

DROP TABLE recurring_digest_reports;

CREATE UNIQUE INDEX insight_reports_proactivity_identity ON insight_reports(delivery_id) WHERE kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL;

CREATE UNIQUE INDEX insight_reports_recurring_day ON insight_reports(user_id,local_date,day_from_ms,day_to_ms) WHERE report_json IS NOT NULL;

CREATE INDEX insight_reports_text_expiry ON insight_reports(created_at_ms,user_id,delivery_id) WHERE kind='proactivity-delivery' AND text IS NOT NULL;

CREATE TRIGGER insight_reports_immutable BEFORE UPDATE ON insight_reports
WHEN NOT(OLD.kind='proactivity-delivery' AND OLD.text IS NOT NULL AND NEW.text IS NULL AND NEW.kind IS OLD.kind AND NEW.user_id IS OLD.user_id AND NEW.delivery_id IS OLD.delivery_id AND NEW.role IS OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms IS OLD.scheduled_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.payload_json IS OLD.payload_json AND NEW.presentation_json IS OLD.presentation_json AND NEW.reminder_grant_id IS OLD.reminder_grant_id AND NEW.reminder_expires_at_ms IS OLD.reminder_expires_at_ms AND NEW.instruction_id IS OLD.instruction_id AND NEW.instruction_version IS OLD.instruction_version AND NEW.grant_id IS OLD.grant_id AND NEW.local_date IS OLD.local_date AND NEW.day_from_ms IS OLD.day_from_ms AND NEW.day_to_ms IS OLD.day_to_ms AND NEW.report_json IS OLD.report_json)
BEGIN SELECT RAISE(ABORT,'insight_report_immutable'); END;

CREATE TRIGGER insight_reports_no_delete BEFORE DELETE ON insight_reports
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_reports' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'insight_report_immutable'); END;

CREATE TRIGGER erasure_fence_insight_reports_insert BEFORE INSERT ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_insight_reports_update BEFORE UPDATE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'insight_reports','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'delivery_id',OLD.delivery_id,'role',OLD.role,'consent_grant_id',OLD.consent_grant_id,'offer_id',OLD.offer_id,'text',OLD.text,'scheduled_at_ms',OLD.scheduled_at_ms,'expires_at_ms',OLD.expires_at_ms,'time_zone',OLD.time_zone,'created_at_ms',OLD.created_at_ms,'payload_json',OLD.payload_json,'presentation_json',OLD.presentation_json,'reminder_grant_id',OLD.reminder_grant_id,'reminder_expires_at_ms',OLD.reminder_expires_at_ms,'instruction_id',OLD.instruction_id,'instruction_version',OLD.instruction_version,'grant_id',OLD.grant_id,'local_date',OLD.local_date,'day_from_ms',OLD.day_from_ms,'day_to_ms',OLD.day_to_ms,'report_json',OLD.report_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE VIEW proactivity_delivery_metadata AS
 SELECT o.user_id,o.kind,o.delivery_id,o.state,o.created_at_ms,o.last_attempt_at_ms,o.restart_attempts,r.expires_at_ms,
 (r.kind='weekly-summary' OR r.text IS NOT NULL) AS content_available
 FROM proactivity_delivery_outbox o JOIN insight_reports r ON r.user_id=o.user_id AND r.kind=o.kind AND r.dispatch_reference=o.delivery_id;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_insight_reports',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_insight_reports';

PRAGMA defer_foreign_keys=OFF;
