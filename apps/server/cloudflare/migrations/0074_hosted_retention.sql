-- Permanent Turn outcomes outlive retained evidence. Only Turns with remaining content or
-- cleanup receipts belong to this indexed workset; compaction cannot orphan receipt cleanup.
CREATE INDEX transcript_entries_by_turn ON transcript_entries(user_id, turn_id);
CREATE INDEX hosted_mutation_commits_retention_user ON hosted_mutation_commits(user_id, turn_id);
CREATE INDEX hosted_whatsapp_delivery_retention_user ON hosted_whatsapp_delivery(user_id, turn_id);
CREATE TABLE hosted_turn_retention (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  terminal_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id)
) STRICT;
CREATE INDEX hosted_turn_retention_due
  ON hosted_turn_retention(terminal_at_ms, user_id, turn_id);
CREATE INDEX hosted_turn_retention_user
  ON hosted_turn_retention(user_id, terminal_at_ms, turn_id);
INSERT INTO hosted_turn_retention(turn_id, user_id, terminal_at_ms)
SELECT t.id, t.user_id, t.terminal_at_ms
FROM (
  SELECT user_id, turn_id FROM transcript_entries
  UNION SELECT user_id, turn_id FROM hosted_mutation_commits
  UNION SELECT user_id, turn_id FROM hosted_whatsapp_inbound
) AS e JOIN hosted_turns AS t ON t.id = e.turn_id AND t.user_id = e.user_id
WHERE t.status <> 'pending';
-- Every terminal transition already requires its matching Transcript evidence. Inbound metadata
-- owns its delivery/outbox children through foreign keys, so it keeps their deadline alive too.
CREATE TRIGGER hosted_turn_retention_terminal AFTER UPDATE ON hosted_turns
WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
BEGIN
  INSERT INTO hosted_turn_retention(turn_id, user_id, terminal_at_ms)
  VALUES (NEW.id, NEW.user_id, NEW.terminal_at_ms);
END;
CREATE TRIGGER hosted_retention_transcript_append AFTER INSERT ON transcript_entries
BEGIN
  INSERT OR IGNORE INTO hosted_turn_retention(turn_id, user_id, terminal_at_ms)
  SELECT id, user_id, terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending';
END;
CREATE TRIGGER hosted_retention_transcript_remove AFTER DELETE ON transcript_entries
WHEN NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
)
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;
CREATE TRIGGER hosted_retention_mutation_append AFTER INSERT ON hosted_mutation_commits
BEGIN
  INSERT OR IGNORE INTO hosted_turn_retention(turn_id, user_id, terminal_at_ms)
  SELECT id, user_id, terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending';
END;
CREATE TRIGGER hosted_retention_mutation_remove AFTER DELETE ON hosted_mutation_commits
WHEN NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
)
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;
CREATE TRIGGER hosted_retention_channel_append AFTER INSERT ON hosted_whatsapp_inbound
BEGIN
  INSERT OR IGNORE INTO hosted_turn_retention(turn_id, user_id, terminal_at_ms)
  SELECT id, user_id, terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending';
END;
CREATE TRIGGER hosted_retention_channel_remove AFTER DELETE ON hosted_whatsapp_inbound
WHEN NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
)
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;
CREATE INDEX hosted_turns_pending_due ON hosted_turns(started_at_ms, user_id)
  WHERE status = 'pending';
CREATE INDEX hosted_compacted_retention_due ON hosted_compacted_conversations(updated_at_ms, user_id);
CREATE INDEX hosted_compacted_retention_user ON hosted_compacted_conversations(user_id, updated_at_ms);
CREATE INDEX hosted_compaction_attempts_due ON hosted_compaction_attempts(day_ms, user_id);
CREATE INDEX hosted_confirmations_retention_due ON hosted_confirmations(expires_at_ms, user_id);
CREATE INDEX hosted_confirmations_retention_user ON hosted_confirmations(user_id, expires_at_ms);
