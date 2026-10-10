-- 0077 initialized progress once. Validate that initialization, including already-processing
-- submissions, in one linear pass over receipts. A gap, foreign owner or disagreement aborts
-- this migration; normal retry never reconstructs history. Each submission is capped at 20,000.
INSERT INTO statement_submission_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM statement_submissions s LEFT JOIN (
    SELECT submission_id, user_id, count(*) AS total, max(record_number) AS last_record,
      sum(outcome='accepted') AS accepted, sum(outcome='needs-review') AS review
    FROM statement_record_outcomes GROUP BY submission_id, user_id
  ) o ON o.submission_id=s.id AND o.user_id=s.user_id
  WHERE s.processed_rows<>coalesce(o.total,0)
    OR s.processed_rows<>coalesce(o.last_record,0)
    OR s.processed_accepted_rows<>coalesce(o.accepted,0)
    OR s.processed_review_rows<>coalesce(o.review,0)
    OR s.processed_rows>20000
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted;

CREATE TRIGGER statement_progress_initial BEFORE INSERT ON statement_submissions
WHEN NEW.processed_rows<>0 OR NEW.processed_accepted_rows<>0 OR NEW.processed_review_rows<>0
BEGIN SELECT RAISE(ABORT,'statement_progress_initial'); END;

-- Immutable receipts and ordered insertion prove the prefix. Only its newest indexed receipt
-- is needed to validate an increment; state-only updates must conserve the validated counts.
CREATE TRIGGER statement_progress_conservation BEFORE UPDATE ON statement_submissions
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
  OR NEW.processed_rows NOT BETWEEN 0 AND 20000
  OR NEW.processed_rows<>NEW.processed_accepted_rows+NEW.processed_review_rows
  OR NEW.processed_rows<>coalesce((SELECT record_number FROM statement_record_outcomes
    WHERE submission_id=NEW.id ORDER BY record_number DESC LIMIT 1),0)
  OR NOT (
    (NEW.processed_rows=OLD.processed_rows
      AND NEW.processed_accepted_rows=OLD.processed_accepted_rows
      AND NEW.processed_review_rows=OLD.processed_review_rows)
    OR (NEW.processed_rows=OLD.processed_rows+1
      AND NEW.processed_accepted_rows=OLD.processed_accepted_rows+
        (SELECT outcome='accepted' FROM statement_record_outcomes
          WHERE submission_id=NEW.id AND user_id=NEW.user_id AND record_number=NEW.processed_rows)
      AND NEW.processed_review_rows=OLD.processed_review_rows+
        (SELECT outcome='needs-review' FROM statement_record_outcomes
          WHERE submission_id=NEW.id AND user_id=NEW.user_id AND record_number=NEW.processed_rows))
  )
BEGIN SELECT RAISE(ABORT,'statement_progress_conservation'); END;

CREATE TRIGGER statement_progress_terminal BEFORE UPDATE ON statement_submissions
WHEN (OLD.status IN ('completed','failed') AND NEW.status<>OLD.status)
  OR (NEW.status='completed' AND (NEW.processed_rows=0
    OR NEW.input_rows IS NOT NEW.processed_rows
    OR NEW.accepted_rows IS NOT NEW.processed_accepted_rows
    OR NEW.needs_review_rows IS NOT NEW.processed_review_rows))
  OR (NEW.status='failed' AND NEW.input_rows IS NOT NULL AND (
    NEW.input_rows IS NOT NEW.processed_rows
    OR NEW.accepted_rows IS NOT NEW.processed_accepted_rows
    OR NEW.needs_review_rows IS NOT NEW.processed_review_rows))
  OR (NEW.status='failed' AND OLD.status='failed' AND NEW.processed_rows>0
    AND NEW.input_rows IS NULL)
BEGIN SELECT RAISE(ABORT,'statement_progress_terminal'); END;

DROP TRIGGER statement_partial_accounting_on_failure;
CREATE TRIGGER statement_partial_accounting_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status='failed' AND OLD.status IN ('queued','processing')
  AND NEW.input_rows IS NULL AND NEW.processed_rows>0
BEGIN
  UPDATE statement_submissions SET input_rows=processed_rows,
    accepted_rows=processed_accepted_rows, needs_review_rows=processed_review_rows
    WHERE id=NEW.id AND user_id=NEW.user_id;
END;
