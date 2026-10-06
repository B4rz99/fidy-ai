-- A single verified physical message may settle both threshold events.
DROP TRIGGER insight_delivery_attempts_no_update;
DROP TRIGGER insight_delivery_attempts_no_delete;
ALTER TABLE insight_delivery_attempts RENAME TO insight_delivery_attempts_pre_group;
CREATE TABLE insight_delivery_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 sent_at TEXT NOT NULL,
 channel TEXT NOT NULL,
 provider TEXT NOT NULL,
 provider_message_id TEXT NOT NULL,
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 UNIQUE(user_id,insight_event_id)
) STRICT;
INSERT INTO insight_delivery_attempts SELECT * FROM insight_delivery_attempts_pre_group;
DROP TABLE insight_delivery_attempts_pre_group;
CREATE TRIGGER insight_delivery_attempts_no_update BEFORE UPDATE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
CREATE TRIGGER insight_delivery_attempts_no_delete BEFORE DELETE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
CREATE TABLE budget_alert_occurrences (
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_group_id TEXT NOT NULL,
 threshold INTEGER NOT NULL CHECK(threshold IN (80,100)),
 insight_event_id TEXT NOT NULL,
 crossing_json TEXT NOT NULL CHECK(json_valid(crossing_json)),
 PRIMARY KEY(user_id,delivery_group_id,threshold),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE TRIGGER budget_occurrence_frozen BEFORE UPDATE ON budget_alert_occurrences
BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
CREATE TABLE proactive_transcript_event_links (
 user_id TEXT NOT NULL,
 transcript_id TEXT NOT NULL REFERENCES proactive_transcript_entries(id) ON DELETE CASCADE,
 insight_event_id TEXT NOT NULL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
INSERT INTO proactive_transcript_event_links(user_id,transcript_id,insight_event_id)
 SELECT user_id,id,insight_event_id FROM proactive_transcript_entries;
CREATE TRIGGER proactive_primary_link AFTER INSERT ON proactive_transcript_entries
BEGIN INSERT INTO proactive_transcript_event_links(user_id,transcript_id,insight_event_id) VALUES(NEW.user_id,NEW.id,NEW.insight_event_id); END;
