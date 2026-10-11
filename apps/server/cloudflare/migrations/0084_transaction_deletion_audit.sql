-- Preserve historical metadata, external references, and retention/budget guards.
PRAGMA legacy_alter_table = ON;
ALTER TABLE transaction_audit RENAME TO transaction_audit_previous;
CREATE TABLE transaction_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('transactions.createTransaction', 'transactions.listTransactions',
    'transactions.getTransaction', 'transactions.updateTransaction', 'transactions.deleteTransaction', 'transactions.searchTransactions',
    'transactions.linkTransactions', 'transactions.unlinkTransactions', 'operations.executeAtomicBatch')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed', 'resource_limit')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO transaction_audit SELECT * FROM transaction_audit_previous;
DROP TABLE transaction_audit_previous;
PRAGMA legacy_alter_table = OFF;
CREATE INDEX transaction_audit_by_user_day ON transaction_audit(user_id, occurred_at_ms);
CREATE INDEX transaction_audit_retention ON transaction_audit(occurred_at_ms, id, user_id);
CREATE TRIGGER transaction_audit_no_update BEFORE UPDATE ON transaction_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN NEW.operation != 'operations.executeAtomicBatch' AND (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER session_batch_envelope_daily_budget BEFORE INSERT ON transaction_audit
WHEN NEW.operation = 'operations.executeAtomicBatch'
 AND (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND operation = 'operations.executeAtomicBatch'
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND operation = 'operations.executeAtomicBatch'
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'batch_envelope_limit'); END;
CREATE TRIGGER recurring_shared_transaction_budget BEFORE INSERT ON transaction_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER transaction_audit_no_delete BEFORE DELETE ON transaction_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
