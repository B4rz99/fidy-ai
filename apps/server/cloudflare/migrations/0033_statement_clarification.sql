-- Extraction can finish without completing the User's submission. The original submission
-- accounting remains immutable extraction accounting; decisions own subsequent row settlement.
CREATE TABLE statement_clarifications (
  submission_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting', 'completed', 'abandoned')),
  expires_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  CHECK ((state = 'awaiting') = (ended_at_ms IS NULL)),
  FOREIGN KEY (submission_id, user_id) REFERENCES statement_submissions(id, user_id)
);
CREATE TABLE statement_clarification_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation IN ('ingestion.resolveNeedsReviewItem', 'ingestion.skipNeedsReviewItem', 'ingestion.abandonStatementSubmission')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed', 'resource_limit')),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
CREATE INDEX statement_clarification_audit_retention ON statement_clarification_audit(occurred_at_ms, id, user_id);
CREATE TRIGGER statement_clarification_audit_no_update BEFORE UPDATE ON statement_clarification_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER statement_clarification_audit_no_delete BEFORE DELETE ON statement_clarification_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE INDEX statement_clarification_deadline ON statement_clarifications(expires_at_ms)
  WHERE state = 'awaiting';

CREATE TABLE statement_review_decisions (
  review_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('resolved', 'skipped', 'abandoned')),
  transaction_id TEXT,
  decided_at_ms INTEGER NOT NULL,
  CHECK ((decision = 'resolved') = (transaction_id IS NOT NULL)),
  FOREIGN KEY (review_id) REFERENCES statement_needs_review(id),
  FOREIGN KEY (submission_id, user_id) REFERENCES statement_submissions(id, user_id),
  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions(id, user_id)
);
CREATE INDEX statement_decisions_submission ON statement_review_decisions(submission_id, decision);

DROP TRIGGER statement_review_expiry_only;
CREATE TRIGGER statement_review_settlement_only BEFORE UPDATE ON statement_needs_review
WHEN NOT (OLD.status = 'pending' AND NEW.status IN ('expired', 'resolved')
  AND NEW.original_evidence IS NULL AND NEW.known_money IS NULL
  AND NEW.id = OLD.id AND NEW.user_id = OLD.user_id
  AND NEW.submission_id = OLD.submission_id AND NEW.record_number = OLD.record_number
  AND NEW.reason = OLD.reason AND NEW.issues = OLD.issues
  AND NEW.evidence_expires_at_ms = OLD.evidence_expires_at_ms
  AND NEW.created_at_ms = OLD.created_at_ms AND NEW.service_market = OLD.service_market
  AND NEW.locale = OLD.locale AND NEW.time_zone = OLD.time_zone
  AND NEW.source_format = OLD.source_format AND NEW.parser_revision = OLD.parser_revision
  AND NEW.extractor_revision = OLD.extractor_revision
  AND (NEW.status = 'expired' OR EXISTS (SELECT 1 FROM statement_review_decisions
    WHERE review_id = OLD.id AND user_id = OLD.user_id AND decision = 'resolved')))
BEGIN SELECT RAISE(ABORT, 'review_immutable'); END;

CREATE TRIGGER statement_decision_guard BEFORE INSERT ON statement_review_decisions
WHEN NOT EXISTS (SELECT 1 FROM statement_needs_review r
  JOIN statement_clarifications c ON c.submission_id = r.submission_id AND c.user_id = r.user_id
  WHERE r.id = NEW.review_id AND r.user_id = NEW.user_id AND r.submission_id = NEW.submission_id
    AND ((NEW.decision = 'abandoned' AND c.state = 'abandoned' AND r.status IN ('pending', 'expired'))
      OR (NEW.decision IN ('resolved', 'skipped') AND c.state = 'awaiting'
        AND c.expires_at_ms > NEW.decided_at_ms AND r.status = 'pending'
        AND r.evidence_expires_at_ms > NEW.decided_at_ms)))
BEGIN SELECT RAISE(ABORT, 'statement_decision_unavailable'); END;
CREATE TRIGGER statement_decision_immutable BEFORE UPDATE ON statement_review_decisions
BEGIN SELECT RAISE(ABORT, 'statement_decision_immutable'); END;

CREATE TRIGGER statement_decision_settlement AFTER INSERT ON statement_review_decisions
BEGIN
  UPDATE statement_needs_review SET status = CASE WHEN NEW.decision = 'resolved' THEN 'resolved' ELSE 'expired' END,
    original_evidence = NULL, known_money = NULL WHERE id = NEW.review_id AND status = 'pending';
  UPDATE statement_backfill_entitlements SET consumed_at_ms = coalesce(consumed_at_ms, NEW.decided_at_ms)
    WHERE user_id = NEW.user_id AND submission_id = NEW.submission_id AND NEW.decision = 'resolved';
  UPDATE statement_clarifications SET state = 'completed', ended_at_ms = NEW.decided_at_ms
    WHERE submission_id = NEW.submission_id AND state = 'awaiting'
      AND NOT EXISTS (SELECT 1 FROM statement_needs_review r WHERE r.submission_id = NEW.submission_id
        AND NOT EXISTS (SELECT 1 FROM statement_review_decisions d WHERE d.review_id = r.id));
  UPDATE statement_backfill_entitlements SET submission_id = NULL
    WHERE user_id = NEW.user_id AND submission_id = NEW.submission_id AND consumed_at_ms IS NULL
      AND EXISTS (SELECT 1 FROM statement_clarifications WHERE submission_id = NEW.submission_id AND state != 'awaiting');
END;

CREATE TRIGGER statement_clarification_transition BEFORE UPDATE OF state ON statement_clarifications
WHEN NOT (OLD.state = 'awaiting' AND NEW.state IN ('completed', 'abandoned') AND NEW.ended_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'statement_clarification_terminal'); END;
CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF state ON statement_clarifications
WHEN NEW.state = 'abandoned'
BEGIN
  INSERT INTO statement_review_decisions (review_id, submission_id, user_id, decision, decided_at_ms)
    SELECT id, submission_id, user_id, 'abandoned', NEW.ended_at_ms FROM statement_needs_review r
    WHERE submission_id = NEW.submission_id
      AND NOT EXISTS (SELECT 1 FROM statement_review_decisions d WHERE d.review_id = r.id);
  UPDATE statement_backfill_entitlements SET submission_id = NULL
    WHERE user_id = NEW.user_id AND submission_id = NEW.submission_id AND consumed_at_ms IS NULL;
END;

CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed', 'failed') AND OLD.status IN ('queued', 'processing') AND NEW.needs_review_rows > 0
BEGIN
  INSERT INTO statement_clarifications (submission_id, user_id, state, expires_at_ms)
    SELECT NEW.id, NEW.user_id, 'awaiting', min(NEW.completed_at_ms + 900000,
      min(evidence_expires_at_ms)) FROM statement_needs_review WHERE submission_id = NEW.id;
  UPDATE statement_clarifications SET state = 'abandoned', ended_at_ms = NEW.completed_at_ms
    WHERE submission_id = NEW.id AND (NEW.status = 'failed' OR expires_at_ms <= NEW.completed_at_ms OR EXISTS
      (SELECT 1 FROM statement_needs_review WHERE submission_id = NEW.id AND status = 'expired'));
END;
