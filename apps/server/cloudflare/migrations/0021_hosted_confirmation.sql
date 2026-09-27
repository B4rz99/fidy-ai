-- A browser-visible challenge binds one exact canonical call to the stable User and original Turn.
-- A consumed challenge remains metadata-only evidence until retention removes it.
CREATE TABLE hosted_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  issued_turn_id TEXT NOT NULL REFERENCES hosted_turns(id),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  command TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_turn_id TEXT REFERENCES hosted_turns(id),
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms > issued_at_ms),
  CHECK ((consumed_turn_id IS NULL) = (consumed_at_ms IS NULL))
) STRICT;
CREATE INDEX hosted_confirmations_open_by_user ON hosted_confirmations(user_id, issued_at_ms DESC)
  WHERE consumed_turn_id IS NULL;
CREATE UNIQUE INDEX hosted_confirmations_one_consumption ON hosted_confirmations(consumed_turn_id)
  WHERE consumed_turn_id IS NOT NULL;
CREATE TRIGGER hosted_confirmations_consume_once BEFORE UPDATE ON hosted_confirmations
WHEN OLD.consumed_turn_id IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.issued_turn_id <> OLD.issued_turn_id OR NEW.operation <> OLD.operation
  OR NEW.input_json <> OLD.input_json OR NEW.command <> OLD.command
  OR NEW.issued_at_ms <> OLD.issued_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR NEW.consumed_turn_id IS NULL OR NEW.consumed_at_ms IS NULL
BEGIN SELECT RAISE(ABORT, 'hosted_confirmation_consume_once'); END;
CREATE TRIGGER hosted_confirmations_no_delete_active BEFORE DELETE ON hosted_confirmations
WHEN OLD.expires_at_ms >= unixepoch('now') * 1000
BEGIN SELECT RAISE(ABORT, 'hosted_confirmation_retention_not_due'); END;
