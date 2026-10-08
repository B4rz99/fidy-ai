-- Public references identify a review; browser proof and originating-chat confirmation supply authority.
CREATE TABLE whatsapp_provider_handoffs (
 id TEXT PRIMARY KEY NOT NULL,
 exchange_id TEXT NOT NULL REFERENCES pending_consent_exchanges(id) ON DELETE CASCADE,
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=created_at_ms AND expires_at_ms<=created_at_ms+600000),
 handoff_send_started_ms INTEGER,
 pairing_id TEXT UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
 review_code TEXT UNIQUE,
 review_started_ms INTEGER,
 review_message_id TEXT CHECK(review_message_id IS NULL OR length(review_message_id) BETWEEN 1 AND 256),
 decision TEXT CHECK(decision IN ('confirmed','denied')),
 decision_message_id TEXT CHECK(decision_message_id IS NULL OR length(decision_message_id) BETWEEN 1 AND 256),
 confirmed_at_ms INTEGER,
 consumed_at_ms INTEGER
) STRICT;
CREATE INDEX whatsapp_handoff_exchange ON whatsapp_provider_handoffs(exchange_id,created_at_ms);
ALTER TABLE provider_authentication_attempts ADD COLUMN handoff_id TEXT REFERENCES whatsapp_provider_handoffs(id) ON DELETE CASCADE;
CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE INSERT ON completed_provider_authentications
WHEN EXISTS(SELECT 1 FROM provider_authentication_attempts WHERE id=NEW.attempt_id AND handoff_id IS NOT NULL)
AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a
 JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id AND h.pairing_id=a.pairing_id
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN whatsapp_identities w ON w.user_id=NEW.user_id AND w.portfolio_id=e.portfolio_id AND w.bsuid=e.bsuid
 WHERE a.id=NEW.attempt_id AND h.decision='confirmed' AND h.review_message_id IS NOT NULL
 AND h.decision_message_id IS NOT NULL AND h.confirmed_at_ms IS NOT NULL AND h.consumed_at_ms IS NULL
 AND h.expires_at_ms>NEW.completed_at_ms AND e.expires_at_ms>NEW.completed_at_ms AND e.state='accepted'
)
BEGIN SELECT RAISE(ABORT,'whatsapp_provider_confirmation_invalid'); END;
CREATE TRIGGER whatsapp_provider_completion_consumes_confirmation AFTER INSERT ON completed_provider_authentications
BEGIN
 UPDATE whatsapp_provider_handoffs SET consumed_at_ms=NEW.completed_at_ms WHERE id=(SELECT handoff_id FROM provider_authentication_attempts WHERE id=NEW.attempt_id);
END;
DROP TRIGGER provider_completion_requires_proof;
CREATE TRIGGER provider_completion_requires_proof BEFORE INSERT ON completed_provider_authentications
WHEN NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.attempt_id AND a.state='verified'
 AND a.expires_at_ms>NEW.completed_at_ms AND p.expires_at_ms>NEW.completed_at_ms AND p.wrong_attempts<5
 AND (NEW.created_user=0 OR (
 a.intent='signup' AND EXISTS(SELECT 1 FROM onboarding_consent_records g WHERE g.user_id=NEW.user_id
 AND ((a.handoff_id IS NULL AND g.id=a.id AND g.disclosure_json=a.disclosure_json)
 OR (a.handoff_id IS NOT NULL AND g.id=(SELECT exchange_id FROM whatsapp_provider_handoffs WHERE id=a.handoff_id))))
 AND EXISTS(SELECT 1 FROM trial_periods t WHERE t.user_id=NEW.user_id AND t.started_at_ms=NEW.completed_at_ms)
 AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;
CREATE TRIGGER provider_attempt_requires_handoff BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.handoff_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM whatsapp_provider_handoffs h JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 WHERE h.id=NEW.handoff_id AND h.pairing_id=NEW.pairing_id AND h.expires_at_ms>NEW.created_at_ms
 AND h.consumed_at_ms IS NULL AND h.decision IS NULL AND e.state='accepted' AND e.expires_at_ms>NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT,'provider_handoff_invalid'); END;
