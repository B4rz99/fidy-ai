-- Private preparation metadata; grants no institution authority and stores no bank material.
-- Attempts already carry the immutable original deadline and bounded retention.
CREATE TABLE connection_authorization_executions (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES connection_attempts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  prepared_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER connection_execution_binding BEFORE INSERT ON connection_authorization_executions
WHEN NOT EXISTS (
  SELECT 1 FROM connection_attempts a JOIN web_sessions s ON s.user_id = a.user_id
  WHERE a.id = NEW.attempt_id AND s.id = NEW.session_id AND a.status = 'consumed'
    AND a.consumed_at_ms = NEW.prepared_at_ms
)
BEGIN SELECT RAISE(ABORT, 'connection_execution_binding'); END;
CREATE TRIGGER connection_execution_immutable BEFORE UPDATE ON connection_authorization_executions
BEGIN SELECT RAISE(ABORT, 'connection_execution_immutable'); END;
CREATE TABLE connection_browser_atomic_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accepted INTEGER NOT NULL CONSTRAINT connection_browser_commit CHECK (accepted = 1)
) STRICT;
