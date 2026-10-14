-- Review evidence is not a captured Transaction and does not consume the lifetime Free grant.
-- First capture spends the reservation in the same D1 unit as the row and SourceAttestation.
CREATE TRIGGER statement_backfill_on_capture AFTER INSERT ON statement_record_outcomes
WHEN NEW.outcome = 'accepted'
BEGIN
  UPDATE statement_backfill_entitlements
    SET consumed_at_ms = coalesce(consumed_at_ms, unixepoch('now') * 1000)
    WHERE user_id = NEW.user_id AND submission_id = NEW.submission_id;
END;

-- Retention failure preserves a spent grant but releases review-only reservations.
DROP TRIGGER statement_partial_backfill_on_failure;
CREATE TRIGGER statement_partial_backfill_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
BEGIN
  UPDATE statement_backfill_entitlements
    SET submission_id = CASE WHEN consumed_at_ms IS NULL THEN NULL ELSE submission_id END
    WHERE user_id = NEW.user_id AND submission_id = NEW.id;
END;
