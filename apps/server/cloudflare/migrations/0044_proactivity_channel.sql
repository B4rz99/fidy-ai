-- WhatsApp owns one-shot claims and authenticated delivery evidence, not reports.
CREATE TABLE proactivity_whatsapp_claims (
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('budget-threshold','manual-entry-reminder','budget-offer','reminder-offer','reminder-question')),
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
 CHECK((role IN ('budget-offer','reminder-offer') AND consent_grant_id IS NULL) OR (role IN ('budget-threshold','manual-entry-reminder','reminder-question') AND consent_grant_id IS NOT NULL)),
 CHECK(state NOT IN ('sending','accepted','ambiguous','rejected','delivered') OR send_started_at_ms IS NOT NULL),
 CHECK(state<>'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),
 PRIMARY KEY(user_id,delivery_id),
 UNIQUE(user_id,provider_message_id)
) STRICT;
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
