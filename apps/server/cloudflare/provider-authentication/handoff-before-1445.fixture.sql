CREATE TRIGGER whatsapp_provider_completion_consumes_confirmation AFTER UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL
BEGIN
 UPDATE whatsapp_provider_handoffs SET consumed_at_ms=NEW.completed_at_ms WHERE id=(SELECT handoff_id FROM provider_authentication_attempts WHERE id=NEW.id);
END;
