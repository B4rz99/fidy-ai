-- A signed callback can outrun or outlive the HTTP send response. The correlation token
-- was committed before the call; the first authenticated message id fences later evidence.
DROP TRIGGER pending_consent_delivery_requires_attempt;
CREATE TRIGGER pending_consent_delivery_requires_attempt BEFORE INSERT ON pending_consent_delivery
WHEN NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e WHERE e.correlation_token = NEW.correlation_token
    AND e.state = 'outbound_started' AND e.phone_number_id = NEW.phone_number_id
    AND (e.disclosure_message_id IS NULL OR e.disclosure_message_id = NEW.message_id)
    AND NEW.occurred_at_ms >= (e.created_at_ms / 1000) * 1000 AND NEW.occurred_at_ms < e.expires_at_ms
    AND NEW.received_at_ms < e.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'pending_consent_invalid_delivery'); END;
DROP TRIGGER pending_consent_delivery_opens_decision;
CREATE TRIGGER pending_consent_delivery_opens_decision AFTER INSERT ON pending_consent_delivery
BEGIN
  UPDATE pending_consent_exchanges SET state = 'awaiting_decision', disclosed_at_ms = NEW.occurred_at_ms,
    decision_not_before_ms = NEW.decision_not_before_ms,
    disclosure_message_id = NEW.message_id WHERE correlation_token = NEW.correlation_token;
END;

-- Window is operational timing evidence, never User authority.
CREATE TABLE hosted_whatsapp_windows (
 user_id TEXT NOT NULL, portfolio_id TEXT NOT NULL, bsuid TEXT NOT NULL,
 last_verified_inbound_at_ms INTEGER NOT NULL, closes_at_ms INTEGER NOT NULL,
 PRIMARY KEY (user_id, portfolio_id, bsuid),
 CHECK (closes_at_ms = last_verified_inbound_at_ms + 86400000)
) STRICT;
CREATE INDEX hosted_whatsapp_windows_expiry ON hosted_whatsapp_windows(closes_at_ms);
