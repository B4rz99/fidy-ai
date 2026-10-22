CREATE TRIGGER provider_completion_immutable BEFORE UPDATE ON provider_authentication_attempts
WHEN (OLD.completed_at_ms IS NOT NULL AND (NEW.completed_at_ms IS NOT OLD.completed_at_ms OR NEW.created_user IS NOT OLD.created_user OR NEW.user_id IS NOT OLD.user_id OR NEW.state<>'completed'))
 OR (NEW.completed_at_ms IS NOT OLD.completed_at_ms AND NOT(OLD.completed_at_ms IS NULL AND OLD.state='verified' AND NEW.state='completed' AND NEW.user_id IS NOT NULL AND NEW.cookie_digest=zeroblob(32) AND NEW.nonce='' AND NEW.contact_email IS NULL))
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;
