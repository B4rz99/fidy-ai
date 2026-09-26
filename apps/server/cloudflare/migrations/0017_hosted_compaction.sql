-- Charge expensive pre-admission generation even when a request aborts before a Turn exists.
CREATE TABLE hosted_compaction_attempts (
  user_id TEXT NOT NULL REFERENCES users(id),
  day_ms INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 3),
  PRIMARY KEY (user_id, day_ms)
) STRICT;
-- One replacement per Hosted Agent Session. The nonce fences stale and concurrent attempts.
CREATE TABLE hosted_compacted_conversations (
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  nonce TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, hosted_session_id),
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id)
) STRICT;
-- Compaction, unlike retention, removes only an exact terminal prefix backed by a committed replacement.
DROP TRIGGER transcript_retention_guard;
CREATE TRIGGER transcript_retention_guard BEFORE DELETE ON transcript_entries
WHEN NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id AND user_id = OLD.user_id
  AND status <> 'pending' AND terminal_at_ms < (unixepoch('now') * 1000 - 2592000000))
AND NOT EXISTS (SELECT 1 FROM hosted_compacted_conversations AS c
  JOIN hosted_turns AS t ON t.id = OLD.turn_id AND t.user_id = OLD.user_id
  WHERE c.user_id = OLD.user_id AND c.hosted_session_id = OLD.hosted_session_id
    AND c.through_sequence >= OLD.sequence AND t.status <> 'pending')
BEGIN SELECT RAISE(ABORT, 'transcript_retention_not_due'); END;
