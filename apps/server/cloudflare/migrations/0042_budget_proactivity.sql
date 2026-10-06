-- Eligibility is captured with the crossing, never inferred from a later grant.
ALTER TABLE budget_threshold_alerts ADD COLUMN delivery_group_id TEXT;
ALTER TABLE budget_threshold_alerts ADD COLUMN consent_grant_id TEXT;
CREATE TABLE budget_crossing_publications (
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_group_id TEXT NOT NULL,
 detected_at_ms INTEGER NOT NULL,
 materialized_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,delivery_group_id)
) STRICT;
CREATE INDEX budget_crossing_publication_due ON budget_crossing_publications(materialized_at_ms,last_evaluated_at_ms,detected_at_ms);
CREATE TRIGGER budget_crossing_delivery_frozen BEFORE UPDATE OF delivery_group_id,consent_grant_id ON budget_threshold_alerts
WHEN NEW.delivery_group_id IS NOT OLD.delivery_group_id OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
BEGIN SELECT RAISE(ABORT,'budget_delivery_eligibility_immutable'); END;
-- Survives later Budget deletion and replacement; a User gets this milestone once.
CREATE TABLE budget_first_creation (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 budget_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 offer_requested_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TRIGGER budget_first_creation_capture AFTER INSERT ON budgets
BEGIN
 INSERT OR IGNORE INTO budget_first_creation(user_id,budget_id,created_at_ms)
 VALUES(NEW.user_id,NEW.id,CAST(unixepoch(NEW.created_at)*1000 AS INTEGER));
END;
