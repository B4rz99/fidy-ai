-- Authenticated inbound evidence is metadata only; exact text remains exclusively in the Transcript.
CREATE TABLE hosted_whatsapp_inbound (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  business_phone_number_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id),
  UNIQUE (user_id, turn_id),
  UNIQUE (portfolio_id, message_id),
  CHECK (received_at_ms >= occurred_at_ms - 300000)
) STRICT;
CREATE INDEX hosted_whatsapp_inbound_user ON hosted_whatsapp_inbound(user_id, turn_id);
CREATE TRIGGER hosted_whatsapp_inbound_no_update BEFORE UPDATE ON hosted_whatsapp_inbound
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_inbound_immutable'); END;
-- Identity-only outbox is created with the Pending Turn and survives webhook/Queue interruption.
CREATE TABLE hosted_whatsapp_outbox (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  offered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_whatsapp_inbound(user_id, turn_id)
) STRICT;
CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_whatsapp_outbox(offered_at_ms, created_at_ms);

-- The visible answer is only a proposal until Kapso attests delivery. A send is never retried
-- once started: an ambiguous HTTP outcome may have been displayed to the User.
CREATE TABLE hosted_whatsapp_delivery (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  correlation_token TEXT NOT NULL UNIQUE,
  business_phone_number_id TEXT NOT NULL,
  proposed_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending','accepted','ambiguous','rejected','delivered','unconfirmed')),
  provider_message_id TEXT,
  delivered_at_ms INTEGER,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_whatsapp_inbound(user_id, turn_id),
  CHECK ((state = 'delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at_ms IS NULL))
) STRICT;
CREATE TRIGGER hosted_whatsapp_delivery_identity_immutable BEFORE UPDATE ON hosted_whatsapp_delivery
WHEN NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.correlation_token <> OLD.correlation_token
  OR NEW.business_phone_number_id <> OLD.business_phone_number_id
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
  OR OLD.state IN ('rejected','delivered','unconfirmed')
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_delivery_immutable'); END;
CREATE TABLE hosted_whatsapp_delivery_events (
  correlation_token TEXT NOT NULL REFERENCES hosted_whatsapp_delivery(correlation_token),
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','failed')),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (correlation_token, provider_message_id, status, occurred_at_ms)
) STRICT;
CREATE TRIGGER hosted_whatsapp_delivery_event_immutable BEFORE UPDATE ON hosted_whatsapp_delivery_events
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_event_immutable'); END;

DROP TRIGGER hosted_turns_terminal_evidence;
CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required'); END;
