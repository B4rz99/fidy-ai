CREATE TABLE recurring_digest_instructions (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 id TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 grant_id TEXT NOT NULL REFERENCES proactivity_consent_records(id),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 acceptance_from_ms INTEGER NOT NULL,
 accepted_at_ms INTEGER NOT NULL,
 last_source_identity TEXT,
 next_closed_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE recurring_digest_scans (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 checkpoint TEXT NOT NULL,
 cursor TEXT,
 cutoff_at_ms INTEGER NOT NULL,
 complete INTEGER NOT NULL CHECK(complete IN (0,1))
) STRICT;
CREATE TABLE recurring_digest_staging (
 user_id TEXT NOT NULL REFERENCES users(id),
 confirmation_id TEXT NOT NULL,
 confirmed_at_ms INTEGER NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 item_json TEXT,
 eligible TEXT NOT NULL CHECK(eligible IN ('eligible','suppressed','invalid','legacy')),
 PRIMARY KEY(user_id,confirmation_id)
) STRICT;
CREATE TABLE recurring_digest_consumption (
 user_id TEXT NOT NULL REFERENCES users(id),
 confirmation_id TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('included','suppressed','invalid','excluded')),
 PRIMARY KEY(user_id,confirmation_id)
) STRICT;
CREATE TRIGGER recurring_digest_consumption_immutable BEFORE UPDATE ON recurring_digest_consumption
 BEGIN SELECT RAISE(ABORT,'recurring_consumption_immutable'); END;
CREATE TABLE recurring_digest_reports (
 user_id TEXT NOT NULL REFERENCES users(id),
 insight_event_id TEXT NOT NULL,
 instruction_id TEXT NOT NULL,
 instruction_version INTEGER NOT NULL,
 grant_id TEXT NOT NULL,
 local_date TEXT NOT NULL,
 day_from_ms INTEGER NOT NULL,
 day_to_ms INTEGER NOT NULL CHECK(day_to_ms>day_from_ms),
 report_json TEXT NOT NULL CHECK(json_valid(report_json)),
 PRIMARY KEY(user_id,insight_event_id),
 UNIQUE(user_id,local_date,day_from_ms,day_to_ms),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE TRIGGER recurring_digest_report_immutable BEFORE UPDATE ON recurring_digest_reports
 BEGIN SELECT RAISE(ABORT,'recurring_report_immutable'); END;
CREATE TABLE recurring_digest_days (
 user_id TEXT NOT NULL REFERENCES users(id),
 local_date TEXT NOT NULL,
 day_from_ms INTEGER NOT NULL,
 day_to_ms INTEGER NOT NULL,
 insight_event_id TEXT,
 PRIMARY KEY(user_id,local_date,day_from_ms,day_to_ms)
) STRICT;
CREATE TABLE recurring_digest_opportunities (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL
) STRICT;
