-- Extend only the existing metadata-only evidence vocabulary. Preserve retained evidence,
-- append-only guards, daily budget and the Audit owner's policy-bound retention path.
CREATE TABLE dashboard_audit_initialization (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('dashboard.getDashboard', 'dashboard.getDashboardView',
    'dashboard.listDashboardCatalog', 'dashboard.applyDashboardEdit', 'dashboard.initializeDashboard')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO dashboard_audit_initialization SELECT * FROM dashboard_audit;
DROP TABLE dashboard_audit;
ALTER TABLE dashboard_audit_initialization RENAME TO dashboard_audit;
CREATE INDEX dashboard_audit_by_user_day ON dashboard_audit(user_id, occurred_at_ms);
CREATE INDEX dashboard_audit_retention ON dashboard_audit(occurred_at_ms, id, user_id);
CREATE TRIGGER dashboard_audit_no_update BEFORE UPDATE ON dashboard_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER dashboard_audit_no_delete BEFORE DELETE ON dashboard_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER dashboard_audit_daily_budget BEFORE INSERT ON dashboard_audit
WHEN (SELECT COUNT(*) FROM dashboard_audit WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
