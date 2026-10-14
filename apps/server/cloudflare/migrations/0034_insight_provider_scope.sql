-- Caller-reported external identifiers cannot reserve another User's provider namespace.
-- Preserve immutable primary delivery evidence while qualifying its uniqueness by User.
DROP TRIGGER insight_delivery_attempts_no_update;
DROP TRIGGER insight_delivery_attempts_no_delete;
ALTER TABLE insight_delivery_attempts RENAME TO insight_delivery_attempts_previous;
CREATE TABLE insight_delivery_attempts (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 sent_at TEXT NOT NULL, channel TEXT NOT NULL, provider TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 UNIQUE(user_id,insight_event_id), UNIQUE(user_id,provider,provider_message_id)
) STRICT;
INSERT INTO insight_delivery_attempts SELECT * FROM insight_delivery_attempts_previous;
DROP TABLE insight_delivery_attempts_previous;
CREATE TRIGGER insight_delivery_attempts_no_update BEFORE UPDATE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
CREATE TRIGGER insight_delivery_attempts_no_delete BEFORE DELETE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
