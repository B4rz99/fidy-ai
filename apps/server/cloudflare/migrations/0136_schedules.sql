PRAGMA defer_foreign_keys=ON;

CREATE TABLE schedules (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 next_scheduled_at TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 proactivity_grant_type TEXT GENERATED ALWAYS AS (CASE WHEN kind='reminder' THEN 'proactivity_grant' END) VIRTUAL,
 PRIMARY KEY(kind,id),
 UNIQUE(kind,user_id),
 UNIQUE(user_id,kind,id),
 FOREIGN KEY(user_id,proactivity_grant_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)
) STRICT;

CREATE TABLE schedule_revisions (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),
 user_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(user_id,kind,schedule_id,version),
 FOREIGN KEY(user_id,kind,schedule_id) REFERENCES schedules(user_id,kind,id)
) STRICT;

CREATE TABLE schedule_executions (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),
 user_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL,
 schedule_version INTEGER NOT NULL,
 scheduled_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('generated','expired') OR (kind='weekly' AND outcome='empty')),
 PRIMARY KEY(user_id,kind,schedule_id,schedule_version,scheduled_at),
 FOREIGN KEY(user_id,kind,schedule_id) REFERENCES schedules(user_id,kind,id)
) STRICT;

INSERT INTO schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms)
SELECT 'weekly',id,user_id,version,enabled,json_object('id',id,'userId',user_id,'version',version,'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END),'timing',json_object('weekday',weekday,'hour',hour,'minute',minute),'timeZone',time_zone,'serviceMarket',service_market,'locale',locale,'nextScheduledAt',next_scheduled_at,'consentGrantId',consent_grant_id),next_scheduled_at,consent_grant_id,last_evaluated_at_ms FROM weekly_schedules;

INSERT INTO schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms)
SELECT 'reminder',id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms FROM reminder_schedules;

INSERT INTO schedule_revisions(kind,user_id,schedule_id,version,snapshot_json) SELECT 'weekly',user_id,schedule_id,version,snapshot_json FROM weekly_schedule_revisions;

INSERT INTO schedule_revisions(kind,user_id,schedule_id,version,snapshot_json) SELECT 'reminder',user_id,schedule_id,version,snapshot_json FROM reminder_schedule_revisions;

INSERT INTO schedule_executions(kind,user_id,schedule_id,schedule_version,scheduled_at,outcome) SELECT 'weekly',user_id,schedule_id,schedule_version,scheduled_at,outcome FROM weekly_schedule_executions;

INSERT INTO schedule_executions(kind,user_id,schedule_id,schedule_version,scheduled_at,outcome) SELECT 'reminder',user_id,schedule_id,schedule_version,scheduled_at,outcome FROM reminder_schedule_executions;

DROP TRIGGER weekly_schedule_revision_no_update;

DROP TRIGGER weekly_schedule_executions_no_update;

DROP TRIGGER reminder_revision_no_update;

DROP TRIGGER weekly_schedule_revision_no_delete;

DROP TRIGGER weekly_schedule_executions_no_delete;

DROP TRIGGER reminder_revision_no_delete;

DROP TRIGGER erasure_fence_reminder_schedule_executions_insert;

DROP TRIGGER erasure_fence_reminder_schedule_executions_update;

DROP TRIGGER erasure_fence_reminder_schedule_executions_delete;

DROP TRIGGER erasure_fence_reminder_schedule_revisions_insert;

DROP TRIGGER erasure_fence_reminder_schedule_revisions_update;

DROP TRIGGER erasure_fence_reminder_schedule_revisions_delete;

DROP TRIGGER erasure_fence_weekly_schedule_executions_insert;

DROP TRIGGER erasure_fence_weekly_schedule_executions_update;

DROP TRIGGER erasure_fence_weekly_schedule_executions_delete;

DROP TRIGGER erasure_fence_weekly_schedule_revisions_insert;

DROP TRIGGER erasure_fence_weekly_schedule_revisions_update;

DROP TRIGGER erasure_fence_weekly_schedule_revisions_delete;

DROP TRIGGER erasure_fence_weekly_schedules_insert;

DROP TRIGGER erasure_fence_weekly_schedules_update;

DROP TRIGGER erasure_fence_weekly_schedules_delete;

DROP TRIGGER erasure_preserve_reminder_schedule_executions_delete;

DROP TRIGGER erasure_preserve_reminder_schedule_revisions_delete;

DROP TRIGGER erasure_preserve_weekly_schedule_executions_delete;

DROP TRIGGER erasure_preserve_weekly_schedule_revisions_delete;

DROP TRIGGER erasure_preserve_weekly_schedules_delete;

DROP TRIGGER erasure_fence_reminder_schedules_insert;

DROP TRIGGER erasure_fence_reminder_schedules_update;

DROP TRIGGER erasure_fence_reminder_schedules_delete;

DROP TRIGGER erasure_preserve_reminder_schedules_delete;

DROP TABLE weekly_schedule_revisions;

DROP TABLE weekly_schedule_executions;

DROP TABLE weekly_schedules;

DROP TABLE reminder_schedule_revisions;

DROP TABLE reminder_schedule_executions;

DROP TABLE reminder_schedules;

CREATE INDEX schedules_due ON schedules(kind,enabled,last_evaluated_at_ms,next_scheduled_at,id);

CREATE TRIGGER schedules_identity_immutable BEFORE UPDATE ON schedules WHEN NEW.kind<>OLD.kind OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id BEGIN SELECT RAISE(ABORT,'schedule_identity_immutable'); END;

CREATE TRIGGER erasure_fence_schedules_insert BEFORE INSERT ON schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedules_update BEFORE UPDATE ON schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedules_delete BEFORE DELETE ON schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_schedules_delete BEFORE DELETE ON schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedules','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'id',OLD.id,'user_id',OLD.user_id,'version',OLD.version,'enabled',OLD.enabled,'snapshot_json',OLD.snapshot_json,'next_scheduled_at',OLD.next_scheduled_at,'consent_grant_id',OLD.consent_grant_id,'last_evaluated_at_ms',OLD.last_evaluated_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER schedule_revisions_no_update BEFORE UPDATE ON schedule_revisions BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;

CREATE TRIGGER schedule_revisions_no_delete BEFORE DELETE ON schedule_revisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_revisions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;

CREATE TRIGGER erasure_fence_schedule_revisions_insert BEFORE INSERT ON schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedule_revisions_update BEFORE UPDATE ON schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedule_revisions_delete BEFORE DELETE ON schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_schedule_revisions_delete BEFORE DELETE ON schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_revisions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'version',OLD.version,'snapshot_json',OLD.snapshot_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER schedule_executions_no_update BEFORE UPDATE ON schedule_executions BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;

CREATE TRIGGER schedule_executions_no_delete BEFORE DELETE ON schedule_executions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_executions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;

CREATE TRIGGER erasure_fence_schedule_executions_insert BEFORE INSERT ON schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedule_executions_update BEFORE UPDATE ON schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_schedule_executions_delete BEFORE DELETE ON schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_schedule_executions_delete BEFORE DELETE ON schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_executions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'schedule_version',OLD.schedule_version,'scheduled_at',OLD.scheduled_at,'outcome',OLD.outcome) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_schedules',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_schedules';

PRAGMA defer_foreign_keys=OFF;
