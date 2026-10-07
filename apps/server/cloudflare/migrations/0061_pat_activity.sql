ALTER TABLE pat_audit ADD COLUMN hosted_turn_id TEXT REFERENCES hosted_turns(id);

-- PAT activity answers consume the same stable-User canonical Audit budget.
DROP VIEW canonical_audit_usage;
CREATE VIEW canonical_audit_usage AS
SELECT * FROM (
SELECT user_id, occurred_at_ms FROM transaction_audit WHERE operation != 'operations.executeAtomicBatch'
UNION ALL SELECT user_id, occurred_at_ms FROM pat_audit
  WHERE operation != 'operations.executeAtomicBatch'
  AND (((pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL))
    AND operation NOT LIKE 'pats.%') OR operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
UNION ALL SELECT user_id, occurred_at_ms FROM category_audit
UNION ALL SELECT user_id, occurred_at_ms FROM memory_audit)
UNION ALL SELECT user_id, occurred_at_ms FROM statement_submission_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_review_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_clarification_audit;

DROP TRIGGER pat_canonical_daily_budget;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (((NEW.pat_id IS NOT NULL OR (NEW.oauth_connection_id IS NOT NULL AND NEW.oauth_credential_id IS NOT NULL))
  AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

DROP TRIGGER recurring_shared_pat_budget;
CREATE TRIGGER recurring_shared_pat_budget BEFORE INSERT ON pat_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (((NEW.pat_id IS NOT NULL OR (NEW.oauth_connection_id IS NOT NULL AND NEW.oauth_credential_id IS NOT NULL))
  AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

CREATE INDEX pat_audit_activity ON pat_audit(user_id, pat_id, occurred_at_ms DESC, id DESC);
