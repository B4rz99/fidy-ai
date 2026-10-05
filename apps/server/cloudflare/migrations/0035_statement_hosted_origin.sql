-- Routing context is installed only by the server's verified hosted publication adapter.
-- The deadline tracks Agent's activity projection in the same Agent lifecycle unit.
CREATE TABLE statement_hosted_origins (
  submission_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  abandoned_at_ms INTEGER,
  FOREIGN KEY (submission_id, user_id) REFERENCES statement_submissions(id, user_id)
);
CREATE INDEX statement_hosted_session ON statement_hosted_origins(user_id, session_id);
CREATE INDEX statement_hosted_expiry ON statement_hosted_origins(expires_at_ms)
  WHERE abandoned_at_ms IS NULL;
CREATE TRIGGER statement_origin_no_resumption BEFORE UPDATE ON statement_hosted_origins
WHEN OLD.abandoned_at_ms IS NOT NULL OR NEW.submission_id != OLD.submission_id
  OR NEW.user_id != OLD.user_id OR NEW.session_id != OLD.session_id OR NEW.turn_id != OLD.turn_id
BEGIN SELECT RAISE(ABORT, 'statement_origin_terminal'); END;

DROP TRIGGER statement_extraction_clarification;
CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed', 'failed') AND OLD.status IN ('queued', 'processing') AND NEW.needs_review_rows > 0
BEGIN
  INSERT INTO statement_clarifications (submission_id, user_id, state, expires_at_ms)
    SELECT NEW.id, NEW.user_id, 'awaiting', min(coalesce(
      (SELECT expires_at_ms FROM statement_hosted_origins WHERE submission_id = NEW.id),
      NEW.completed_at_ms + 900000), min(evidence_expires_at_ms))
    FROM statement_needs_review WHERE submission_id = NEW.id;
  UPDATE statement_clarifications SET state = 'abandoned', ended_at_ms = NEW.completed_at_ms
    WHERE submission_id = NEW.id AND (NEW.status = 'failed' OR expires_at_ms <= NEW.completed_at_ms OR EXISTS
      (SELECT 1 FROM statement_needs_review WHERE submission_id = NEW.id AND status = 'expired')
      OR EXISTS (SELECT 1 FROM statement_hosted_origins WHERE submission_id = NEW.id AND abandoned_at_ms IS NOT NULL));
END;
