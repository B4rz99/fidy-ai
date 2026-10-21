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
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision', 'accepted', 'declined')), rejected_at_ms INTEGER
  CHECK (rejected_at_ms IS NULL OR rejected_at_ms BETWEEN created_at_ms AND expires_at_ms), sandbox_phone TEXT
  CHECK (sandbox_phone IS NULL OR length(sandbox_phone) BETWEEN 8 AND 16), delivery_phone_number_id TEXT, delivery_message_id TEXT, delivery_occurred_at_ms INTEGER, delivery_received_at_ms INTEGER, delivery_not_before_ms INTEGER, decision_portfolio_id TEXT, decision_bsuid TEXT, decision_phone_number_id TEXT, decision_value TEXT, decision_disclosure_json TEXT, decision_disclosure_message_id TEXT, decision_message_id TEXT, decision_delivery_key TEXT, decision_body_sha256 TEXT, decision_occurred_at_ms INTEGER, decision_received_at_ms INTEGER CHECK((delivery_message_id IS NULL AND delivery_phone_number_id IS NULL AND delivery_message_id IS NULL AND delivery_occurred_at_ms IS NULL AND delivery_received_at_ms IS NULL AND delivery_not_before_ms IS NULL) OR (delivery_message_id IS NOT NULL AND delivery_phone_number_id IS NOT NULL AND (length(delivery_phone_number_id) BETWEEN 1 AND 32) AND delivery_message_id IS NOT NULL AND (length(delivery_message_id) BETWEEN 1 AND 256) AND delivery_occurred_at_ms IS NOT NULL AND delivery_received_at_ms IS NOT NULL AND delivery_not_before_ms IS NOT NULL AND (delivery_not_before_ms >= delivery_received_at_ms))) CHECK((decision_value IS NULL AND decision_portfolio_id IS NULL AND decision_bsuid IS NULL AND decision_phone_number_id IS NULL AND decision_value IS NULL AND decision_disclosure_json IS NULL AND decision_disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_delivery_key IS NULL AND decision_body_sha256 IS NULL AND decision_occurred_at_ms IS NULL AND decision_received_at_ms IS NULL) OR (decision_value IS NOT NULL AND decision_portfolio_id IS NOT NULL AND decision_bsuid IS NOT NULL AND decision_phone_number_id IS NOT NULL AND (length(decision_phone_number_id) BETWEEN 1 AND 32) AND decision_value IS NOT NULL AND (decision_value IN ('accepted', 'declined')) AND decision_disclosure_json IS NOT NULL AND decision_disclosure_message_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision_delivery_key IS NOT NULL AND (length(decision_delivery_key) BETWEEN 1 AND 256) AND decision_body_sha256 IS NOT NULL AND (length(decision_body_sha256) = 64) AND decision_occurred_at_ms IS NOT NULL AND decision_received_at_ms IS NOT NULL)),
  UNIQUE (portfolio_id, initiating_message_id),
  CHECK (expires_at_ms = created_at_ms + 86400000),
  CHECK (disclosed_at_ms IS NULL OR disclosed_at_ms BETWEEN (created_at_ms / 1000) * 1000 AND expires_at_ms)
) STRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX pending_consent_decisions_identity_0 ON pending_consent_exchanges(decision_portfolio_id,decision_message_id) WHERE decision_value IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'pending_consent_exchanges','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'phone_number_id',OLD."phone_number_id",'initiating_message_id',OLD."initiating_message_id",'initiating_body_sha256',OLD."initiating_body_sha256",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'created_at_ms',OLD."created_at_ms",'disclosed_at_ms',OLD."disclosed_at_ms",'decision_not_before_ms',OLD."decision_not_before_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'rejected_at_ms',OLD."rejected_at_ms",'sandbox_phone',OLD."sandbox_phone",'delivery_phone_number_id',OLD.delivery_phone_number_id,'delivery_message_id',OLD.delivery_message_id,'delivery_occurred_at_ms',OLD.delivery_occurred_at_ms,'delivery_received_at_ms',OLD.delivery_received_at_ms,'delivery_not_before_ms',OLD.delivery_not_before_ms,'decision_portfolio_id',OLD.decision_portfolio_id,'decision_bsuid',OLD.decision_bsuid,'decision_phone_number_id',OLD.decision_phone_number_id,'decision_value',OLD.decision_value,'decision_disclosure_json',OLD.decision_disclosure_json,'decision_disclosure_message_id',OLD.decision_disclosure_message_id,'decision_message_id',OLD.decision_message_id,'decision_delivery_key',OLD.decision_delivery_key,'decision_body_sha256',OLD.decision_body_sha256,'decision_occurred_at_ms',OLD.decision_occurred_at_ms,'decision_received_at_ms',OLD.decision_received_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decision_requires_delivery BEFORE UPDATE OF decision_portfolio_id,decision_bsuid,decision_phone_number_id,decision_value,decision_disclosure_json,decision_disclosure_message_id,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NULL AND NEW.decision_value IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e
  WHERE e.id = NEW.id AND e.portfolio_id = NEW.decision_portfolio_id AND e.bsuid = NEW.decision_bsuid
    AND e.phone_number_id = NEW.decision_phone_number_id AND e.state = 'awaiting_decision' AND e.disclosure_json = NEW.decision_disclosure_json
    AND e.disclosure_message_id = NEW.decision_disclosure_message_id
    AND NEW.decision_message_id <> e.initiating_message_id
    -- Kapso timestamps have second precision: equal timestamps cannot prove reply order.
    AND NEW.decision_occurred_at_ms > e.disclosed_at_ms AND NEW.decision_occurred_at_ms > e.decision_not_before_ms
    AND NEW.decision_occurred_at_ms < e.expires_at_ms
    AND NEW.decision_received_at_ms < e.expires_at_ms
))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_invalid_decision');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decision_settles AFTER UPDATE OF decision_portfolio_id,decision_bsuid,decision_phone_number_id,decision_value,decision_disclosure_json,decision_disclosure_message_id,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NULL AND NEW.decision_value IS NOT NULL
BEGIN
 UPDATE pending_consent_exchanges SET state = NEW.decision_value WHERE id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decisions_no_update BEFORE UPDATE OF decision_portfolio_id,decision_bsuid,decision_phone_number_id,decision_value,decision_disclosure_json,decision_disclosure_message_id,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NOT NULL AND (NEW.decision_portfolio_id IS NOT OLD.decision_portfolio_id OR NEW.decision_bsuid IS NOT OLD.decision_bsuid OR NEW.decision_phone_number_id IS NOT OLD.decision_phone_number_id OR NEW.decision_value IS NOT OLD.decision_value OR NEW.decision_disclosure_json IS NOT OLD.decision_disclosure_json OR NEW.decision_disclosure_message_id IS NOT OLD.decision_disclosure_message_id OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision_delivery_key IS NOT OLD.decision_delivery_key OR NEW.decision_body_sha256 IS NOT OLD.decision_body_sha256 OR NEW.decision_occurred_at_ms IS NOT OLD.decision_occurred_at_ms OR NEW.decision_received_at_ms IS NOT OLD.decision_received_at_ms) AND NEW.decision_value IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_exchanges_companions_initial BEFORE INSERT ON pending_consent_exchanges WHEN NEW.delivery_phone_number_id IS NOT NULL OR NEW.delivery_message_id IS NOT NULL OR NEW.delivery_occurred_at_ms IS NOT NULL OR NEW.delivery_received_at_ms IS NOT NULL OR NEW.delivery_not_before_ms IS NOT NULL OR NEW.decision_portfolio_id IS NOT NULL OR NEW.decision_bsuid IS NOT NULL OR NEW.decision_phone_number_id IS NOT NULL OR NEW.decision_value IS NOT NULL OR NEW.decision_disclosure_json IS NOT NULL OR NEW.decision_disclosure_message_id IS NOT NULL OR NEW.decision_message_id IS NOT NULL OR NEW.decision_delivery_key IS NOT NULL OR NEW.decision_body_sha256 IS NOT NULL OR NEW.decision_occurred_at_ms IS NOT NULL OR NEW.decision_received_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'pending_consent_exchanges_companions_initial'); END;
