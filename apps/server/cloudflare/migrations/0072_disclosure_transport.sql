-- Temporary delivery evidence follows the existing 24-hour pre-User retention.
ALTER TABLE pending_consent_exchanges ADD COLUMN rejected_at_ms INTEGER
  CHECK (rejected_at_ms IS NULL OR rejected_at_ms BETWEEN created_at_ms AND expires_at_ms);
ALTER TABLE pending_consent_exchanges ADD COLUMN sandbox_phone TEXT
  CHECK (sandbox_phone IS NULL OR length(sandbox_phone) BETWEEN 8 AND 16);

CREATE TRIGGER pending_consent_rejected_delivery BEFORE INSERT ON pending_consent_delivery
WHEN EXISTS (SELECT 1 FROM pending_consent_exchanges
  WHERE correlation_token = NEW.correlation_token AND rejected_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'pending_consent_rejected_delivery'); END;
