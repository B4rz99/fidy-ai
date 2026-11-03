CREATE TABLE pro_grant_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  operator TEXT NOT NULL CHECK (length(operator) BETWEEN 1 AND 128),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX pro_grant_user_sequence ON pro_grant_events(user_id, sequence DESC);
--> statement-breakpoint
CREATE TRIGGER pro_grant_events_immutable BEFORE UPDATE ON pro_grant_events
BEGIN SELECT RAISE(ABORT, 'Pro grant evidence is immutable'); END;
