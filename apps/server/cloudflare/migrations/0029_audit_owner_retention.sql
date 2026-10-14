-- Bound maintenance discovery to the oldest metadata instead of scanning retained histories.
CREATE INDEX transaction_audit_retention ON transaction_audit(occurred_at_ms, id, user_id);
CREATE INDEX pat_audit_retention ON pat_audit(occurred_at_ms, id, user_id);
CREATE INDEX category_audit_retention ON category_audit(occurred_at_ms, id, user_id);
CREATE INDEX memory_audit_retention ON memory_audit(occurred_at_ms, id, user_id);
CREATE INDEX budget_audit_retention ON budget_audit(occurred_at_ms, id, user_id);
CREATE INDEX dashboard_audit_retention ON dashboard_audit(occurred_at_ms, id, user_id);
CREATE INDEX insight_audit_retention ON insight_audit(occurred_at_ms, id, user_id);
CREATE INDEX statement_submission_audit_retention ON statement_submission_audit(occurred_at_ms, id, user_id);
CREATE INDEX statement_review_audit_retention ON statement_review_audit(occurred_at_ms, id, user_id);
CREATE INDEX email_replacement_audit_retention ON email_replacement_audit(occurred_at_ms, id, user_id);
-- Audit owns the sole policy-bound deletion path. A permit exists only inside the
-- retention batch, is scoped to one User and cutoff, and is removed before commit.
-- Updates remain forbidden. Ordinary Audit operations expose no retention permit.
CREATE TABLE audit_retention_permits (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  cutoff_ms INTEGER NOT NULL
) STRICT;
DROP TRIGGER transaction_audit_no_delete;
CREATE TRIGGER transaction_audit_no_delete BEFORE DELETE ON transaction_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER pat_audit_no_delete;
CREATE TRIGGER pat_audit_no_delete BEFORE DELETE ON pat_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER category_audit_no_delete;
CREATE TRIGGER category_audit_no_delete BEFORE DELETE ON category_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER memory_audit_no_delete;
CREATE TRIGGER memory_audit_no_delete BEFORE DELETE ON memory_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER budget_audit_no_delete;
CREATE TRIGGER budget_audit_no_delete BEFORE DELETE ON budget_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER dashboard_audit_no_delete;
CREATE TRIGGER dashboard_audit_no_delete BEFORE DELETE ON dashboard_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER insight_audit_no_delete;
CREATE TRIGGER insight_audit_no_delete BEFORE DELETE ON insight_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER statement_submission_audit_no_delete;
CREATE TRIGGER statement_submission_audit_no_delete BEFORE DELETE ON statement_submission_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
DROP TRIGGER statement_review_audit_no_delete;
CREATE TRIGGER statement_review_audit_no_delete BEFORE DELETE ON statement_review_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER email_replacement_audit_no_delete BEFORE DELETE ON email_replacement_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
