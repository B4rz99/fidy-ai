-- Explicit weekly delivery decisions remain Consent-owned and append-only.
CREATE TABLE weekly_consent_offers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  disclosure_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  disclosure_message_id TEXT UNIQUE,
  disclosed_at_ms INTEGER,
  decision_message_id TEXT UNIQUE,
  decision TEXT CHECK(decision IN ('accept','decline','revoke')),
  CHECK ((disclosure_message_id IS NULL) = (disclosed_at_ms IS NULL)),
  CHECK ((decision_message_id IS NULL) = (decision IS NULL))
) STRICT;
CREATE INDEX weekly_consent_offers_user ON weekly_consent_offers(user_id, created_at_ms);
CREATE TABLE weekly_consent_records (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  grant_id TEXT,
  offer_id TEXT NOT NULL UNIQUE REFERENCES weekly_consent_offers(id),
  record_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  FOREIGN KEY(grant_id) REFERENCES weekly_consent_records(id)
) STRICT;
CREATE INDEX weekly_consent_records_user ON weekly_consent_records(user_id, occurred_at_ms);
CREATE UNIQUE INDEX weekly_consent_revocations ON weekly_consent_records(grant_id) WHERE grant_id IS NOT NULL;
CREATE TABLE weekly_consent_assertion (
  id INTEGER PRIMARY KEY CHECK(id = 1), accepted INTEGER NOT NULL CHECK(accepted = 1)
) STRICT;
CREATE TRIGGER weekly_consent_offer_immutable BEFORE UPDATE ON weekly_consent_offers
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.disclosure_json <> OLD.disclosure_json
 OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND (NEW.disclosure_message_id IS NOT OLD.disclosure_message_id OR NEW.disclosed_at_ms IS NOT OLD.disclosed_at_ms))
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;
CREATE TRIGGER weekly_consent_records_no_update BEFORE UPDATE ON weekly_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER weekly_consent_records_no_delete BEFORE DELETE ON weekly_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE weekly_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 59),
  time_zone TEXT NOT NULL,
  service_market TEXT NOT NULL CHECK(service_market = 'CO'),
  locale TEXT NOT NULL CHECK(locale = 'es-CO'),
  next_scheduled_at TEXT NOT NULL,
  consent_grant_id TEXT NOT NULL,
  last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id,id)
) STRICT;
CREATE INDEX weekly_schedules_due ON weekly_schedules(enabled,last_evaluated_at_ms,next_scheduled_at,id);
CREATE TABLE weekly_schedule_revisions (
 user_id TEXT NOT NULL, schedule_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(user_id,schedule_id,version),
 FOREIGN KEY(user_id,schedule_id) REFERENCES weekly_schedules(user_id,id)
) STRICT;
CREATE TRIGGER weekly_schedule_revision_no_update BEFORE UPDATE ON weekly_schedule_revisions
BEGIN SELECT RAISE(ABORT,'weekly_revision_immutable'); END;
CREATE TRIGGER weekly_schedule_revision_no_delete BEFORE DELETE ON weekly_schedule_revisions
BEGIN SELECT RAISE(ABORT,'weekly_revision_immutable'); END;
CREATE TABLE weekly_schedule_executions (
  user_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('generated','empty','expired')),
  PRIMARY KEY(user_id,schedule_id,schedule_version,scheduled_at),
  FOREIGN KEY(user_id,schedule_id) REFERENCES weekly_schedules(user_id,id)
) STRICT;
CREATE TRIGGER weekly_schedule_executions_no_update BEFORE UPDATE ON weekly_schedule_executions
BEGIN SELECT RAISE(ABORT,'weekly_execution_immutable'); END;
CREATE TRIGGER weekly_schedule_executions_no_delete BEFORE DELETE ON weekly_schedule_executions
BEGIN SELECT RAISE(ABORT,'weekly_execution_immutable'); END;
CREATE TABLE weekly_schedule_assertion (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  accepted INTEGER NOT NULL CHECK(accepted = 1)
) STRICT;
