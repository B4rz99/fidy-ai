-- Financial facts and presentation are immutable; only delivery execution can expire.
CREATE TABLE weekly_summary_reports (
 user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 presentation_json TEXT NOT NULL CHECK(json_valid(presentation_json)),
 scheduled_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
 CHECK(expires_at_ms > scheduled_at_ms AND expires_at_ms <= scheduled_at_ms + 86400000),
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE TRIGGER weekly_report_no_update BEFORE UPDATE ON weekly_summary_reports
BEGIN SELECT RAISE(ABORT,'weekly_report_immutable'); END;
CREATE TRIGGER weekly_report_no_delete BEFORE DELETE ON weekly_summary_reports
BEGIN SELECT RAISE(ABORT,'weekly_report_immutable'); END;
CREATE TABLE weekly_summary_outbox (
 user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','started','settled','expired','refused')),
 created_at_ms INTEGER NOT NULL, last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES weekly_summary_reports(user_id,insight_event_id)
) STRICT;
CREATE INDEX weekly_summary_outbox_due ON weekly_summary_outbox(state,last_attempt_at_ms,created_at_ms,insight_event_id);
