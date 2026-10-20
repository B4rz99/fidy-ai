CREATE TABLE proactivity_delivery_outbox (
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('weekly-summary','proactivity-delivery')),
 delivery_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','started','settled','expired','refused')),
 created_at_ms INTEGER NOT NULL,
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3),
 weekly_report_id TEXT GENERATED ALWAYS AS (CASE WHEN kind='weekly-summary' THEN delivery_id END) VIRTUAL,
 proactivity_report_id TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' THEN delivery_id END) VIRTUAL,
 PRIMARY KEY(user_id,kind,delivery_id),
 FOREIGN KEY(user_id,weekly_report_id) REFERENCES weekly_summary_reports(user_id,insight_event_id),
 FOREIGN KEY(user_id,proactivity_report_id) REFERENCES proactivity_reports(user_id,delivery_id)
) STRICT;

INSERT INTO proactivity_delivery_outbox(user_id,kind,delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts)
 SELECT user_id,'weekly-summary',insight_event_id,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM weekly_summary_outbox
 UNION ALL
 SELECT user_id,'proactivity-delivery',delivery_id,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM proactivity_outbox;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_proactivity_outbox_delete;

DROP TRIGGER IF EXISTS erasure_fence_weekly_summary_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_weekly_summary_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_weekly_summary_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_proactivity_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_weekly_summary_outbox_delete;

DROP TABLE weekly_summary_outbox;

DROP TABLE proactivity_outbox;

CREATE INDEX proactivity_delivery_outbox_due ON proactivity_delivery_outbox(state,last_attempt_at_ms,created_at_ms,kind,delivery_id,user_id);

CREATE INDEX proactivity_delivery_outbox_health ON proactivity_delivery_outbox(kind,created_at_ms,user_id,delivery_id)
 WHERE state IN ('ready','started');

CREATE VIEW proactivity_delivery_metadata AS
 SELECT o.user_id,o.kind,o.delivery_id,o.state,o.created_at_ms,o.last_attempt_at_ms,o.restart_attempts,
   r.expires_at_ms,1 AS content_available
 FROM proactivity_delivery_outbox o JOIN weekly_summary_reports r ON r.user_id=o.user_id AND r.insight_event_id=o.delivery_id
 WHERE o.kind='weekly-summary'
 UNION ALL
 SELECT o.user_id,o.kind,o.delivery_id,o.state,o.created_at_ms,o.last_attempt_at_ms,o.restart_attempts,
   r.expires_at_ms,(r.text IS NOT NULL) AS content_available
 FROM proactivity_delivery_outbox o JOIN proactivity_reports r ON r.user_id=o.user_id AND r.delivery_id=o.delivery_id
 WHERE o.kind='proactivity-delivery';

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
