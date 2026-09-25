-- Reversible Reconciliation decisions over two retained Transactions, plus the private member
-- index that makes one Transaction belong to at most one linked pair. No decision rewrites or
-- removes either original Transaction or its SourceAttestations.
CREATE TABLE transaction_reconciliation_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  first_transaction_id TEXT NOT NULL,
  second_transaction_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('linked', 'keep-separate')),
  visible_transaction_id TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (user_id, first_transaction_id, second_transaction_id),
  FOREIGN KEY (user_id, first_transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (user_id, second_transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (user_id, visible_transaction_id) REFERENCES transactions(user_id, id),
  CHECK (first_transaction_id < second_transaction_id),
  CHECK (
    (state = 'linked' AND visible_transaction_id IS NOT NULL
      AND visible_transaction_id IN (first_transaction_id, second_transaction_id))
    OR (state = 'keep-separate' AND visible_transaction_id IS NULL)
  )
) STRICT;
-- The primary key is the atomic one-pair-per-Transaction gate; a second link cannot commit a member.
CREATE TABLE transaction_reconciliation_members (
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  first_transaction_id TEXT NOT NULL,
  second_transaction_id TEXT NOT NULL,
  PRIMARY KEY (user_id, transaction_id),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (user_id, first_transaction_id, second_transaction_id)
    REFERENCES transaction_reconciliation_decisions(user_id, first_transaction_id, second_transaction_id),
  CHECK (transaction_id IN (first_transaction_id, second_transaction_id))
) STRICT;
-- The effective relation's statement-source rank reads one Transaction's attestations on every
-- projected row; without this index that EXISTS scans the attestation table.
CREATE INDEX source_attestations_by_transaction ON source_attestations(user_id, transaction_id);
-- Extend the append-only Transaction audit vocabulary to the two Reconciliation mutations.
DROP TRIGGER pat_canonical_daily_budget;
DROP TRIGGER category_canonical_daily_budget;
CREATE TABLE transaction_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('transactions.createTransaction', 'transactions.listTransactions', 'transactions.getTransaction', 'transactions.updateTransaction', 'transactions.searchTransactions', 'transactions.linkTransactions', 'transactions.unlinkTransactions')),
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
