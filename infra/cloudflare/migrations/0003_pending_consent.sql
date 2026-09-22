-- Pre-subject disclosure evidence. No stable User, WhatsAppIdentity, or ConsentRecord exists here.
CREATE TABLE pending_consent_exchanges (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  portfolio_id TEXT NOT NULL CHECK (length(portfolio_id) BETWEEN 1 AND 128),
  bsuid TEXT NOT NULL CHECK (length(bsuid) BETWEEN 1 AND 256),
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 32),
  initiating_message_id TEXT NOT NULL CHECK (length(initiating_message_id) BETWEEN 1 AND 256),
  initiating_body_sha256 TEXT NOT NULL CHECK (length(initiating_body_sha256) = 64),
  correlation_token TEXT NOT NULL UNIQUE CHECK (length(correlation_token) = 36),
  disclosure_json TEXT NOT NULL CHECK (length(disclosure_json) BETWEEN 1 AND 16000),
  disclosure_message_id TEXT CHECK (length(disclosure_message_id) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL,
  disclosed_at_ms INTEGER,
  decision_not_before_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision', 'accepted', 'declined')),
  UNIQUE (portfolio_id, initiating_message_id),
  CHECK (expires_at_ms = created_at_ms + 86400000),
  CHECK (disclosed_at_ms IS NULL OR disclosed_at_ms BETWEEN (created_at_ms / 1000) * 1000 AND expires_at_ms)
) STRICT;
CREATE UNIQUE INDEX pending_consent_one_caller ON pending_consent_exchanges(portfolio_id, bsuid)
  WHERE state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision');

-- Only a correlated, authenticated Kapso delivered callback may advance the disclosure.
CREATE TABLE pending_consent_delivery (
  correlation_token TEXT PRIMARY KEY NOT NULL REFERENCES pending_consent_exchanges(correlation_token) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 32),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  decision_not_before_ms INTEGER NOT NULL CHECK (decision_not_before_ms >= received_at_ms)
) STRICT;
CREATE TRIGGER pending_consent_delivery_requires_attempt BEFORE INSERT ON pending_consent_delivery
WHEN NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e WHERE e.correlation_token = NEW.correlation_token
    AND e.state = 'outbound_started' AND e.phone_number_id = NEW.phone_number_id
    AND e.disclosure_message_id = NEW.message_id
    AND NEW.occurred_at_ms >= (e.created_at_ms / 1000) * 1000 AND NEW.occurred_at_ms < e.expires_at_ms
    AND NEW.received_at_ms < e.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'pending_consent_invalid_delivery'); END;
CREATE TRIGGER pending_consent_delivery_opens_decision AFTER INSERT ON pending_consent_delivery
BEGIN
  UPDATE pending_consent_exchanges SET state = 'awaiting_decision', disclosed_at_ms = NEW.occurred_at_ms,
    decision_not_before_ms = NEW.decision_not_before_ms,
    disclosure_message_id = NEW.message_id WHERE correlation_token = NEW.correlation_token;
END;
CREATE TRIGGER pending_consent_delivery_no_update BEFORE UPDATE ON pending_consent_delivery
BEGIN SELECT RAISE(ABORT, 'pending_consent_append_only'); END;

-- One terminal pending decision; neither decision creates a stable User or processes finances.
CREATE TABLE pending_consent_decisions (
  exchange_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_consent_exchanges(id) ON DELETE CASCADE,
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 32),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
  disclosure_json TEXT NOT NULL,
  disclosure_message_id TEXT NOT NULL,
  decision_message_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL CHECK (length(delivery_key) BETWEEN 1 AND 256),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  UNIQUE (portfolio_id, decision_message_id)
) STRICT;
CREATE TRIGGER pending_consent_decision_requires_delivery BEFORE INSERT ON pending_consent_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e
  WHERE e.id = NEW.exchange_id AND e.portfolio_id = NEW.portfolio_id AND e.bsuid = NEW.bsuid
    AND e.phone_number_id = NEW.phone_number_id AND e.state = 'awaiting_decision' AND e.disclosure_json = NEW.disclosure_json
    AND e.disclosure_message_id = NEW.disclosure_message_id
    AND NEW.decision_message_id <> e.initiating_message_id
    -- Kapso timestamps have second precision: equal timestamps cannot prove reply order.
    AND NEW.occurred_at_ms > e.disclosed_at_ms AND NEW.occurred_at_ms > e.decision_not_before_ms
    AND NEW.occurred_at_ms < e.expires_at_ms
    AND NEW.received_at_ms < e.expires_at_ms
)
BEGIN SELECT RAISE(ABORT, 'pending_consent_invalid_decision'); END;
CREATE TRIGGER pending_consent_decision_settles AFTER INSERT ON pending_consent_decisions
BEGIN
  UPDATE pending_consent_exchanges SET state = NEW.decision WHERE id = NEW.exchange_id;
END;
CREATE TRIGGER pending_consent_decisions_no_update BEFORE UPDATE ON pending_consent_decisions
BEGIN SELECT RAISE(ABORT, 'pending_consent_append_only'); END;
