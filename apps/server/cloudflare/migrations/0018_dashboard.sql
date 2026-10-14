-- One validated layout per User; every replacement is a compare-and-swap under live authority.
CREATE TABLE dashboard_documents (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;
CREATE TABLE dashboard_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('dashboard.getDashboard', 'dashboard.getDashboardView',
    'dashboard.listDashboardCatalog', 'dashboard.applyDashboardEdit')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX dashboard_audit_by_user_day ON dashboard_audit(user_id, occurred_at_ms);
CREATE TRIGGER dashboard_audit_no_update BEFORE UPDATE ON dashboard_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER dashboard_audit_no_delete BEFORE DELETE ON dashboard_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER dashboard_audit_daily_budget BEFORE INSERT ON dashboard_audit
WHEN (SELECT COUNT(*) FROM dashboard_audit WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TABLE dashboard_assertion (id INTEGER PRIMARY KEY CHECK(id = 1), accepted INTEGER NOT NULL CHECK(accepted = 1)) STRICT;
