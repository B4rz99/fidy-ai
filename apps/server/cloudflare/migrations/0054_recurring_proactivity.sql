-- Extend the existing category path while retaining all predecessor evidence and identities.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE proactivity_consent_offers_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')),
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  disclosure_json TEXT NOT NULL CHECK(json_valid(disclosure_json)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>created_at_ms),
  disclosure_message_id TEXT,
  decision_message_id TEXT UNIQUE,
  decision TEXT CHECK(decision IN ('accept','decline','revoke')),
  UNIQUE(user_id,kind,id),
  CHECK((decision IS NULL)=(decision_message_id IS NULL))
) STRICT;
INSERT INTO proactivity_consent_offers_next SELECT id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,decision_message_id,decision FROM proactivity_consent_offers;
DROP TABLE proactivity_consent_offers;
ALTER TABLE proactivity_consent_offers_next RENAME TO proactivity_consent_offers;
CREATE INDEX proactivity_consent_offers_user ON proactivity_consent_offers(user_id,kind,created_at_ms);
CREATE TRIGGER proactivity_offer_immutable BEFORE UPDATE ON proactivity_consent_offers
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind
 OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.bsuid IS NOT OLD.bsuid
 OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND NEW.disclosure_message_id IS NOT OLD.disclosure_message_id)
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
BEGIN SELECT RAISE(ABORT,'consent_offer_immutable'); END;
CREATE TABLE proactivity_consent_records_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')),
  grant_id TEXT UNIQUE REFERENCES proactivity_consent_records(id),
  offer_id TEXT NOT NULL REFERENCES proactivity_consent_offers(id),
  decision_message_id TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(user_id,kind,id)
) STRICT;
INSERT INTO proactivity_consent_records_next SELECT * FROM proactivity_consent_records;
DROP TABLE proactivity_consent_records;
ALTER TABLE proactivity_consent_records_next RENAME TO proactivity_consent_records;
CREATE INDEX proactivity_consent_records_user ON proactivity_consent_records(user_id,kind,grant_id);
CREATE TRIGGER proactivity_consent_records_no_update BEFORE UPDATE ON proactivity_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER proactivity_consent_records_no_delete BEFORE DELETE ON proactivity_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE proactivity_reports_next (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT REFERENCES proactivity_consent_records(id),
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 UNIQUE(user_id,delivery_id),
 CHECK((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL))
) STRICT;
INSERT INTO proactivity_reports_next SELECT * FROM proactivity_reports;
DROP TABLE proactivity_reports;
ALTER TABLE proactivity_reports_next RENAME TO proactivity_reports;
CREATE TRIGGER proactivity_report_immutable BEFORE UPDATE ON proactivity_reports
WHEN NOT (OLD.text IS NOT NULL AND NEW.text IS NULL AND NEW.delivery_id=OLD.delivery_id AND NEW.user_id=OLD.user_id AND NEW.role=OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms=OLD.scheduled_at_ms AND NEW.expires_at_ms=OLD.expires_at_ms AND NEW.time_zone=OLD.time_zone AND NEW.created_at_ms=OLD.created_at_ms)
BEGIN SELECT RAISE(ABORT,'proactivity_report_immutable'); END;
CREATE TABLE proactivity_offer_requests_next (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')),
 request_message_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 materialized_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 delivery_id TEXT,
 UNIQUE(user_id,kind,request_message_id)
) STRICT;
INSERT INTO proactivity_offer_requests_next SELECT * FROM proactivity_offer_requests;
DROP TABLE proactivity_offer_requests;
ALTER TABLE proactivity_offer_requests_next RENAME TO proactivity_offer_requests;
CREATE INDEX proactivity_offer_requests_due ON proactivity_offer_requests(materialized_at_ms,last_evaluated_at_ms,created_at_ms);
CREATE TABLE proactivity_whatsapp_claims_next (
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT,
 correlation_token TEXT NOT NULL UNIQUE,
 portfolio_id TEXT NOT NULL,
 bsuid TEXT NOT NULL,
 business_phone_number_id TEXT NOT NULL,
 template_json TEXT,
 text TEXT,
 scheduled_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')),
 send_started_at_ms INTEGER,
 provider_message_id TEXT,
 delivered_at_ms INTEGER,
 CHECK((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL) OR (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','reminder-question') AND consent_grant_id IS NOT NULL)),
 CHECK(state NOT IN ('sending','accepted','ambiguous','rejected','delivered') OR send_started_at_ms IS NOT NULL),
 CHECK(state<>'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),
 PRIMARY KEY(user_id,delivery_id),
 UNIQUE(user_id,provider_message_id)
) STRICT;
INSERT INTO proactivity_whatsapp_claims_next SELECT * FROM proactivity_whatsapp_claims;
DROP TABLE proactivity_whatsapp_claims;
ALTER TABLE proactivity_whatsapp_claims_next RENAME TO proactivity_whatsapp_claims;
CREATE INDEX proactivity_channel_started ON proactivity_whatsapp_claims(user_id,send_started_at_ms);
CREATE TRIGGER proactivity_channel_frozen BEFORE UPDATE ON proactivity_whatsapp_claims
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id
 OR NEW.role IS NOT OLD.role OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
 OR NEW.correlation_token IS NOT OLD.correlation_token OR NEW.portfolio_id IS NOT OLD.portfolio_id
 OR NEW.bsuid IS NOT OLD.bsuid OR NEW.business_phone_number_id IS NOT OLD.business_phone_number_id
 OR NEW.scheduled_at_ms IS NOT OLD.scheduled_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR NEW.time_zone IS NOT OLD.time_zone
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.template_json IS NOT NULL AND NEW.template_json IS NOT OLD.template_json)
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
BEGIN SELECT RAISE(ABORT,'proactivity_claim_frozen'); END;
CREATE TABLE proactive_message_transcript_entries_next (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('budget-offer','reminder-offer','recurring-offer','reminder-question')),
 occurred_at_ms INTEGER NOT NULL,
 text TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 UNIQUE(user_id,delivery_id)
) STRICT;
INSERT INTO proactive_message_transcript_entries_next SELECT * FROM proactive_message_transcript_entries;
DROP TABLE proactive_message_transcript_entries;
ALTER TABLE proactive_message_transcript_entries_next RENAME TO proactive_message_transcript_entries;
CREATE INDEX proactive_message_transcript_expiry ON proactive_message_transcript_entries(expires_at_ms,id);
CREATE TRIGGER proactive_message_transcript_immutable BEFORE UPDATE ON proactive_message_transcript_entries
BEGIN SELECT RAISE(ABORT,'proactive_message_transcript_immutable'); END;
PRAGMA defer_foreign_keys = OFF;
