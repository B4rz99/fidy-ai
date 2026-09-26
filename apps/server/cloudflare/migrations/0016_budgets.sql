-- One positive monthly Budget per stable User, Category and Currency; revision never changes Currency.
CREATE TABLE budgets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  currency TEXT NOT NULL,
  cap TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, category_id, currency),
  UNIQUE(user_id, id)
) STRICT;
CREATE INDEX budgets_by_user ON budgets(user_id, currency, category_id);
CREATE TRIGGER budget_capacity BEFORE INSERT ON budgets
WHEN (SELECT COUNT(*) FROM budgets WHERE user_id = NEW.user_id) >= 128
BEGIN SELECT RAISE(ABORT, 'budget_capacity_limit'); END;
-- The UTC month and applied zone are part of the mark identity, not SQLite's local month.
CREATE TABLE budget_month_latches (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  from_utc TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  reached_80 INTEGER NOT NULL DEFAULT 0 CHECK(reached_80 IN (0, 1)),
  reached_100 INTEGER NOT NULL DEFAULT 0 CHECK(reached_100 IN (0, 1)),
  PRIMARY KEY(user_id, budget_id, from_utc, time_zone),
  FOREIGN KEY(user_id, budget_id) REFERENCES budgets(user_id, id) ON DELETE CASCADE,
  CHECK(reached_100 = 0 OR reached_80 = 1)
) STRICT;
-- A unique pending occurrence per threshold is the delivery/outbox latch; duplicates never emit.
CREATE TABLE budget_threshold_alerts (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  from_utc TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK(threshold IN (80, 100)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'delivered', 'read', 'dismissed')),
  PRIMARY KEY(user_id, budget_id, from_utc, time_zone, threshold),
  FOREIGN KEY(user_id, budget_id) REFERENCES budgets(user_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE budget_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK(operation IN ('budgets.createBudget', 'budgets.updateBudget',
    'budgets.deleteBudget', 'budgets.listBudgets', 'budgets.getBudget', 'budgets.getBudgetStatus')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX budget_audit_by_user_day ON budget_audit(user_id, occurred_at_ms);
CREATE TRIGGER budget_audit_no_update BEFORE UPDATE ON budget_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER budget_audit_no_delete BEFORE DELETE ON budget_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER budget_audit_daily_budget BEFORE INSERT ON budget_audit
WHEN (SELECT COUNT(*) FROM budget_audit WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
-- The success Audit must immediately follow a guarded write in the same D1 batch.
CREATE TABLE budget_mutation_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  accepted INTEGER NOT NULL CHECK(accepted = 1)
) STRICT;
