-- D1 is the only authority for normalized Transactions and append-only capture/accountability.
CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  counterparty TEXT,
  category_id TEXT NOT NULL REFERENCES categories(id),
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, id)
) STRICT;
CREATE INDEX transactions_by_user_occurrence ON transactions(user_id, occurred_at DESC, created_at DESC, id DESC);
CREATE INDEX transactions_by_user_creation ON transactions(user_id, created_at);
-- A stable-User, UTC-day write budget keeps manual capture bounded across all Worker instances.
CREATE TRIGGER transaction_manual_daily_budget BEFORE INSERT ON transactions
WHEN (SELECT COUNT(*) FROM transactions
      WHERE user_id = NEW.user_id
        AND created_at >= substr(NEW.created_at, 1, 10) || 'T00:00:00.000Z'
        AND created_at < date(NEW.created_at, '+1 day') || 'T00:00:00.000Z') >= 100
BEGIN SELECT RAISE(ABORT, 'transaction_resource_limit'); END;
CREATE TABLE source_attestations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'manual'),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  interpretation_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id)
) STRICT;
CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
CREATE TRIGGER source_attestation_no_delete BEFORE DELETE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
CREATE TABLE transaction_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('transactions.createTransaction', 'transactions.listTransactions', 'transactions.getTransaction')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER transaction_audit_no_update BEFORE UPDATE ON transaction_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER transaction_audit_no_delete BEFORE DELETE ON transaction_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
