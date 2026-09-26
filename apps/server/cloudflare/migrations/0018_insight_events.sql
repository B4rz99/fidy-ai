-- One occurrence per schedule revision and UTC instant. Context and Money remain immutable.
CREATE TABLE insight_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version > 0),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  money_groups_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'delivered', 'read', 'dismissed')),
  UNIQUE(user_id, schedule_id, schedule_version, scheduled_at),
  UNIQUE(user_id, id)
) STRICT;
CREATE INDEX insight_events_pending ON insight_events(user_id, lifecycle_state, scheduled_at, id);
CREATE INDEX insight_events_due ON insight_events(lifecycle_state, scheduled_at, id);
CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed'))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;
CREATE TABLE insight_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  insight_event_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  FOREIGN KEY(user_id, insight_event_id) REFERENCES insight_events(user_id, id),
  UNIQUE(user_id, insight_event_id),
  UNIQUE(provider, provider_message_id)
) STRICT;
CREATE TRIGGER insight_delivery_attempts_no_update BEFORE UPDATE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT, 'insight_delivery_append_only'); END;
CREATE TRIGGER insight_delivery_attempts_no_delete BEFORE DELETE ON insight_delivery_attempts
BEGIN SELECT RAISE(ABORT, 'insight_delivery_append_only'); END;
CREATE TABLE insight_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK(operation IN ('insights.listPendingInsights',
    'insights.markInsightDelivered', 'insights.markInsightRead', 'insights.dismissInsight')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER insight_audit_no_update BEFORE UPDATE ON insight_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER insight_audit_no_delete BEFORE DELETE ON insight_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER insight_audit_daily_budget BEFORE INSERT ON insight_audit
WHEN (SELECT COUNT(*) FROM insight_audit WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TABLE insight_mutation_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  accepted INTEGER NOT NULL CHECK(accepted = 1)
) STRICT;
