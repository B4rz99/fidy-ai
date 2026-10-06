CREATE TABLE proactive_message_transcript_entries (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('budget-offer','reminder-offer','reminder-question')),
 occurred_at_ms INTEGER NOT NULL,
 text TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 UNIQUE(user_id,delivery_id)
) STRICT;
CREATE INDEX proactive_message_transcript_expiry ON proactive_message_transcript_entries(expires_at_ms,id);
CREATE TRIGGER proactive_message_transcript_immutable BEFORE UPDATE ON proactive_message_transcript_entries
BEGIN SELECT RAISE(ABORT,'proactive_message_transcript_immutable'); END;
