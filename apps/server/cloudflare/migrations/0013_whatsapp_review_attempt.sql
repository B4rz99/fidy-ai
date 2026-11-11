ALTER TABLE whatsapp_provider_handoffs ADD COLUMN review_attempt_id TEXT;
--> statement-breakpoint

DROP TRIGGER whatsapp_provider_handoff_immutable;
--> statement-breakpoint

CREATE TRIGGER whatsapp_provider_handoff_immutable BEFORE UPDATE ON whatsapp_provider_handoffs
WHEN NEW.id IS NOT OLD.id OR NEW.exchange_id IS NOT OLD.exchange_id
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.handoff_send_started_ms IS NOT NULL AND NEW.handoff_send_started_ms IS NOT OLD.handoff_send_started_ms)
 OR (OLD.pairing_id IS NOT NULL AND NEW.pairing_id IS NOT OLD.pairing_id)
 OR (OLD.consumed_at_ms IS NOT NULL AND NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
 OR (((OLD.review_code IS NOT NULL AND NEW.review_code IS NOT OLD.review_code)
   OR (OLD.review_attempt_id IS NOT NULL AND NEW.review_attempt_id IS NOT OLD.review_attempt_id)
   OR (OLD.review_started_ms IS NOT NULL AND NEW.review_started_ms IS NOT OLD.review_started_ms)
   OR (OLD.review_message_id IS NOT NULL AND NEW.review_message_id IS NOT OLD.review_message_id)
   OR (OLD.decision IS NOT NULL AND (NEW.decision IS NOT OLD.decision
     OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms)))
   AND NOT (OLD.consumed_at_ms IS NULL AND NEW.review_attempt_id IS NULL
     AND NEW.review_code IS NOT NULL AND NEW.review_started_ms IS NULL AND NEW.review_message_id IS NULL
     AND NEW.decision IS NULL AND NEW.decision_message_id IS NULL AND NEW.confirmed_at_ms IS NULL
     AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a WHERE a.pairing_id=OLD.pairing_id)))
BEGIN SELECT RAISE(ABORT,'whatsapp_handoff_immutable'); END;
--> statement-breakpoint

DROP TRIGGER whatsapp_provider_completion_requires_confirmation;
--> statement-breakpoint

CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND NEW.handoff_id IS NOT NULL
AND NOT EXISTS(
 SELECT 1 FROM whatsapp_provider_handoffs h
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN users w ON w.id=NEW.user_id AND w.whatsapp_portfolio_id=e.portfolio_id AND w.whatsapp_bsuid=e.bsuid
 WHERE h.id=NEW.handoff_id AND h.pairing_id=NEW.pairing_id AND h.review_attempt_id=NEW.id
 AND h.decision='confirmed' AND h.review_message_id IS NOT NULL AND h.review_started_ms IS NOT NULL
 AND h.decision_message_id IS NOT NULL AND h.confirmed_at_ms IS NOT NULL AND h.consumed_at_ms IS NULL
 AND h.expires_at_ms>NEW.completed_at_ms AND e.expires_at_ms>NEW.completed_at_ms AND e.state='accepted'
)
BEGIN SELECT RAISE(ABORT,'whatsapp_provider_confirmation_invalid'); END;
--> statement-breakpoint

DROP TRIGGER whatsapp_signup_immutable;
--> statement-breakpoint

CREATE TRIGGER whatsapp_signup_immutable BEFORE UPDATE ON whatsapp_signup_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.source_portfolio_id IS NOT OLD.source_portfolio_id
 OR NEW.source_bsuid IS NOT OLD.source_bsuid OR NEW.source_phone_number_id IS NOT OLD.source_phone_number_id
 OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_phone IS NOT OLD.source_phone
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.pairing_id IS NOT NULL AND NEW.pairing_id IS NOT OLD.pairing_id)
 OR (OLD.approved_at_ms IS NOT NULL AND NEW.approved_at_ms IS NOT OLD.approved_at_ms)
 OR (OLD.consumed_at_ms IS NOT NULL AND NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
 OR ((OLD.review_attempt_id IS NOT NULL AND (
   NEW.review_code IS NOT OLD.review_code OR NEW.review_attempt_id IS NOT OLD.review_attempt_id
   OR NEW.review_text IS NOT OLD.review_text OR NEW.review_started_ms IS NOT OLD.review_started_ms))
   OR (OLD.decision IS NOT NULL AND (NEW.decision IS NOT OLD.decision
     OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms)))
   AND NOT (OLD.approved_at_ms IS NULL AND OLD.consumed_at_ms IS NULL
     AND NEW.review_attempt_id IS NULL AND NEW.review_text IS NULL AND NEW.review_started_ms IS NULL
     AND NEW.decision IS NULL AND NEW.decision_message_id IS NULL AND NEW.confirmed_at_ms IS NULL
     AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a WHERE a.pairing_id=OLD.pairing_id))
BEGIN SELECT RAISE(ABORT,'whatsapp_signup_immutable'); END;
