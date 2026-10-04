-- Agent-owned exact channel evidence. There is intentionally no requested Turn or fabricated session.
CREATE TABLE proactive_transcript_entries (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 occurred_at_ms INTEGER NOT NULL, text TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms = occurred_at_ms + 2592000000),
 UNIQUE(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE INDEX proactive_transcript_retention ON proactive_transcript_entries(expires_at_ms,user_id);
CREATE TRIGGER proactive_transcript_append_only BEFORE UPDATE ON proactive_transcript_entries
BEGIN SELECT RAISE(ABORT,'proactive_transcript_append_only'); END;
CREATE TRIGGER proactive_transcript_retention_guard BEFORE DELETE ON proactive_transcript_entries
WHEN OLD.expires_at_ms > unixepoch('now') * 1000
BEGIN SELECT RAISE(ABORT,'proactive_transcript_retention_not_due'); END;
