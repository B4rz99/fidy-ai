-- Frozen disclosure delivery identity survives independent expiry of undecided legal offers.
CREATE TABLE proactivity_message_events_retained AS SELECT * FROM proactivity_message_events;
CREATE TABLE proactivity_outbox_retained AS SELECT * FROM proactivity_outbox;
DROP TABLE proactivity_message_events;
DROP TABLE proactivity_outbox;
CREATE TABLE proactivity_reports_retained (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('budget-threshold','manual-entry-reminder','budget-offer','reminder-offer','reminder-question')),
 consent_grant_id TEXT REFERENCES proactivity_consent_records(id),
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 UNIQUE(user_id,delivery_id),
 CHECK((role IN ('budget-offer','reminder-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL))
) STRICT;
INSERT INTO proactivity_reports_retained SELECT * FROM proactivity_reports;
DROP TABLE proactivity_reports;
ALTER TABLE proactivity_reports_retained RENAME TO proactivity_reports;
CREATE TABLE proactivity_message_events (
 user_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,delivery_id) REFERENCES proactivity_reports(user_id,delivery_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
INSERT INTO proactivity_message_events SELECT * FROM proactivity_message_events_retained;
DROP TABLE proactivity_message_events_retained;
CREATE TABLE proactivity_outbox (
 user_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','started','settled','expired','refused')),
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3),
 PRIMARY KEY(user_id,delivery_id),
 FOREIGN KEY(user_id,delivery_id) REFERENCES proactivity_reports(user_id,delivery_id)
) STRICT;
INSERT INTO proactivity_outbox SELECT * FROM proactivity_outbox_retained;
DROP TABLE proactivity_outbox_retained;
CREATE INDEX proactivity_outbox_due ON proactivity_outbox(state,last_attempt_at_ms,created_at_ms);
CREATE TRIGGER proactivity_report_immutable BEFORE UPDATE ON proactivity_reports
WHEN NOT (OLD.text IS NOT NULL AND NEW.text IS NULL AND NEW.delivery_id=OLD.delivery_id AND NEW.user_id=OLD.user_id AND NEW.role=OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms=OLD.scheduled_at_ms AND NEW.expires_at_ms=OLD.expires_at_ms AND NEW.time_zone=OLD.time_zone AND NEW.created_at_ms=OLD.created_at_ms)
BEGIN SELECT RAISE(ABORT,'proactivity_report_immutable'); END;
