-- Routing is provider-qualified channel metadata, never User authority.
CREATE TABLE insight_whatsapp_routes (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 portfolio_id TEXT NOT NULL, bsuid TEXT NOT NULL, business_phone_number_id TEXT NOT NULL,
 verified_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE insight_whatsapp_claims (
 user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 correlation_token TEXT NOT NULL UNIQUE,
 portfolio_id TEXT NOT NULL, bsuid TEXT NOT NULL, business_phone_number_id TEXT NOT NULL,
 summary_json TEXT, text TEXT,
 scheduled_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, time_zone TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')),
 send_started_at_ms INTEGER, provider_message_id TEXT UNIQUE, delivered_at_ms INTEGER,
 last_received_at_ms INTEGER,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 CHECK(expires_at_ms > scheduled_at_ms AND expires_at_ms <= scheduled_at_ms + 86400000),
 CHECK((state IN ('staged','expired')) OR send_started_at_ms IS NOT NULL),
 CHECK(state <> 'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX insight_whatsapp_verified ON insight_whatsapp_claims(state,user_id,insight_event_id);
CREATE TRIGGER insight_whatsapp_claim_identity BEFORE UPDATE ON insight_whatsapp_claims
WHEN NEW.user_id <> OLD.user_id OR NEW.insight_event_id <> OLD.insight_event_id
 OR NEW.correlation_token <> OLD.correlation_token OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.business_phone_number_id <> OLD.business_phone_number_id
 OR NEW.scheduled_at_ms <> OLD.scheduled_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR NEW.time_zone <> OLD.time_zone
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
 OR (OLD.state <> 'staged' AND NEW.state IN ('staged','expired'))
 OR (OLD.state = 'delivered' AND NEW.state <> 'delivered')
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.summary_json IS NOT NULL AND NEW.summary_json IS NOT OLD.summary_json)
BEGIN SELECT RAISE(ABORT,'insight_claim_invalid'); END;
