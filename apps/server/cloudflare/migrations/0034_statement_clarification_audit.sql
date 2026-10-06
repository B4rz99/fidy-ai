-- Preserve Audit's shared budget and retention policy for conversational decisions.
DROP VIEW IF EXISTS canonical_audit_usage;
CREATE VIEW canonical_audit_usage AS
SELECT * FROM (
SELECT user_id, occurred_at_ms FROM transaction_audit WHERE operation != 'operations.executeAtomicBatch'
UNION ALL SELECT user_id, occurred_at_ms FROM pat_audit WHERE operation != 'operations.executeAtomicBatch'
  AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation IN ('pats.listPATs', 'recurring.listRecurringSeries'))
UNION ALL SELECT user_id, occurred_at_ms FROM category_audit
UNION ALL SELECT user_id, occurred_at_ms FROM memory_audit)
UNION ALL SELECT user_id, occurred_at_ms FROM statement_submission_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_review_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_clarification_audit;
CREATE TRIGGER statement_clarification_audit_budget BEFORE INSERT ON statement_clarification_audit
WHEN (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'statement_audit_limit'); END;
DROP TRIGGER statement_clarification_audit_no_delete;
CREATE TRIGGER statement_clarification_audit_no_delete BEFORE DELETE ON statement_clarification_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
