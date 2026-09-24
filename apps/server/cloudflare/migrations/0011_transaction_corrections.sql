-- SQLite cannot alter a CHECK constraint. Rebuild the audit table so already-migrated
-- databases accept the new operation without discarding capture and browsing history.
DROP TRIGGER pat_canonical_daily_budget;
DROP TRIGGER category_canonical_daily_budget;
CREATE TABLE transaction_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('transactions.createTransaction', 'transactions.listTransactions', 'transactions.getTransaction', 'transactions.updateTransaction')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed', 'resource_limit')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO transaction_audit_next SELECT id, user_id, session_id, operation, outcome, occurred_at_ms FROM transaction_audit;
DROP TABLE transaction_audit;
ALTER TABLE transaction_audit_next RENAME TO transaction_audit;
CREATE INDEX transaction_audit_by_user_day ON transaction_audit(user_id, occurred_at_ms);
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs')
 AND (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER transaction_audit_no_update BEFORE UPDATE ON transaction_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER transaction_audit_no_delete BEFORE DELETE ON transaction_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

-- Revision is the compare-and-swap authority for one normalized movement.
ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE transactions ADD COLUMN user_decisions TEXT NOT NULL DEFAULT '{}';
-- Provider refreshes cannot replace explicitly decided fields without an explicit revisioned correction.
CREATE TRIGGER transaction_user_decisions BEFORE UPDATE ON transactions
WHEN EXISTS (
  SELECT 1 FROM json_each(OLD.user_decisions)
  WHERE value = 1 AND json_extract(NEW.user_decisions, '$.' || key) IS NOT 1
) OR (
  NEW.revision != OLD.revision AND
  (NEW.revision != OLD.revision + 1 OR NOT EXISTS (
    SELECT 1 FROM transaction_corrections
    WHERE user_id = OLD.user_id AND transaction_id = OLD.id AND previous_revision = OLD.revision
  ))
) OR (
  NOT (NEW.revision = OLD.revision + 1 AND EXISTS (
    SELECT 1 FROM transaction_corrections
    WHERE user_id = OLD.user_id AND transaction_id = OLD.id AND previous_revision = OLD.revision
  )) AND (
  (json_extract(OLD.user_decisions, '$.money') = 1 AND (NEW.amount != OLD.amount OR NEW.currency != OLD.currency)) OR
  (json_extract(OLD.user_decisions, '$.direction') = 1 AND NEW.direction != OLD.direction) OR
  (json_extract(OLD.user_decisions, '$.occurredAt') = 1 AND NEW.occurred_at != OLD.occurred_at) OR
  (json_extract(OLD.user_decisions, '$.categoryId') = 1 AND NEW.category_id != OLD.category_id) OR
  (json_extract(OLD.user_decisions, '$.counterparty') = 1 AND NEW.counterparty IS NOT OLD.counterparty) OR
  (json_extract(OLD.user_decisions, '$.notes') = 1 AND NEW.notes IS NOT OLD.notes)
))
BEGIN SELECT RAISE(ABORT, 'transaction_user_decision'); END;
CREATE TABLE transaction_corrections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  changed_fields TEXT NOT NULL,
  before_facts TEXT NOT NULL,
  after_facts TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  UNIQUE (user_id, transaction_id, previous_revision)
) STRICT;
CREATE TRIGGER transaction_correction_no_update BEFORE UPDATE ON transaction_corrections
BEGIN SELECT RAISE(ABORT, 'correction_append_only'); END;
CREATE TRIGGER transaction_correction_no_delete BEFORE DELETE ON transaction_corrections
BEGIN SELECT RAISE(ABORT, 'correction_append_only'); END;
