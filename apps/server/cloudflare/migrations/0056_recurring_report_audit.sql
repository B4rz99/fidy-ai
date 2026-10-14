-- Canonical reminder access shares Insights accountability. A hosted Turn is not a WebSession.
CREATE TABLE insight_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT REFERENCES web_sessions(id),
  hosted_turn_id TEXT REFERENCES hosted_turns(id),
  operation TEXT NOT NULL CHECK(operation IN ('insights.listPendingInsights',
    'insights.markInsightDelivered', 'insights.markInsightRead', 'insights.dismissInsight',
    'insights.getReminderSchedule', 'insights.updateReminderSchedule', 'insights.getRecurringDigestReport')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected')),
  occurred_at_ms INTEGER NOT NULL,
  CHECK ((session_id IS NOT NULL) <> (hosted_turn_id IS NOT NULL))
) STRICT;
INSERT INTO insight_audit_next(id,user_id,session_id,hosted_turn_id,operation,outcome,occurred_at_ms)
SELECT id,user_id,session_id,hosted_turn_id,operation,outcome,occurred_at_ms FROM insight_audit;
DROP TABLE insight_audit;
ALTER TABLE insight_audit_next RENAME TO insight_audit;
CREATE INDEX insight_audit_retention ON insight_audit(occurred_at_ms,id,user_id);
CREATE TRIGGER insight_audit_no_update BEFORE UPDATE ON insight_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER insight_audit_no_delete BEFORE DELETE ON insight_audit
WHEN NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms)
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER insight_audit_daily_budget BEFORE INSERT ON insight_audit
WHEN (SELECT COUNT(*) FROM insight_audit WHERE user_id=NEW.user_id
 AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
 AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
