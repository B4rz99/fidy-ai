CREATE TABLE reminder_schedules (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 next_scheduled_at TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL REFERENCES proactivity_consent_records(id),
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 UNIQUE(user_id,id)
) STRICT;
CREATE INDEX reminder_schedules_due ON reminder_schedules(enabled,last_evaluated_at_ms,next_scheduled_at);
CREATE TABLE reminder_schedule_revisions (
 user_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(user_id,schedule_id,version),
 FOREIGN KEY(user_id,schedule_id) REFERENCES reminder_schedules(user_id,id)
) STRICT;
CREATE TRIGGER reminder_revision_no_update BEFORE UPDATE ON reminder_schedule_revisions
BEGIN SELECT RAISE(ABORT,'reminder_instruction_immutable'); END;
CREATE TRIGGER reminder_revision_no_delete BEFORE DELETE ON reminder_schedule_revisions
BEGIN SELECT RAISE(ABORT,'reminder_instruction_immutable'); END;
CREATE TABLE reminder_governors (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 standing_json TEXT NOT NULL CHECK(json_valid(standing_json)),
 last_reply_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE reminder_schedule_executions (
 user_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL,
 schedule_version INTEGER NOT NULL,
 scheduled_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('generated','expired')),
 PRIMARY KEY(user_id,schedule_id,schedule_version,scheduled_at),
 FOREIGN KEY(user_id,schedule_id) REFERENCES reminder_schedules(user_id,id)
) STRICT;
CREATE TABLE reminder_occurrence_reports (
 user_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL REFERENCES proactivity_consent_records(id),
 expires_at_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE TRIGGER reminder_report_no_update BEFORE UPDATE ON reminder_occurrence_reports
BEGIN SELECT RAISE(ABORT,'reminder_occurrence_immutable'); END;
CREATE TABLE reminder_outbox (
 user_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','started','settled','expired')),
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3),
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE INDEX reminder_outbox_due ON reminder_outbox(state,last_attempt_at_ms,created_at_ms);
CREATE TABLE reminder_schedule_assertion (
 id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
 accepted INTEGER NOT NULL CHECK(accepted=1)
) STRICT;
