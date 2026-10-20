PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS pending_consent_delivery_no_update;

DROP TRIGGER IF EXISTS pending_consent_decision_requires_delivery;

DROP TRIGGER IF EXISTS pending_consent_decision_settles;

DROP TRIGGER IF EXISTS pending_consent_decisions_no_update;

DROP TRIGGER IF EXISTS browser_login_approval_valid;

DROP TRIGGER IF EXISTS browser_login_approval_set_ready;

DROP TRIGGER IF EXISTS web_session_requires_pairing;

DROP TRIGGER IF EXISTS pending_consent_delivery_requires_attempt;

DROP TRIGGER IF EXISTS pending_consent_delivery_opens_decision;

DROP TRIGGER IF EXISTS pending_consent_rejected_delivery;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_approvals_insert;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_approvals_update;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_approvals_delete;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_pairings_insert;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_pairings_update;

DROP TRIGGER IF EXISTS erasure_fence_browser_login_pairings_delete;

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_proofs_insert;

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_proofs_update;

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_proofs_delete;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_exchanges_insert;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_exchanges_update;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_exchanges_delete;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_decisions_insert;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_decisions_update;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_decisions_delete;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_delivery_insert;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_delivery_update;

DROP TRIGGER IF EXISTS erasure_fence_pending_consent_delivery_delete;

DROP TRIGGER IF EXISTS erasure_fence_whatsapp_provider_handoffs_insert;

DROP TRIGGER IF EXISTS erasure_fence_whatsapp_provider_handoffs_update;

DROP TRIGGER IF EXISTS erasure_fence_whatsapp_provider_handoffs_delete;

DROP TRIGGER IF EXISTS erasure_preserve_pending_consent_decisions_delete;

DROP TRIGGER IF EXISTS erasure_preserve_pending_consent_delivery_delete;

DROP TRIGGER IF EXISTS erasure_preserve_pending_consent_exchanges_delete;

DROP TRIGGER IF EXISTS provider_attempt_requires_handoff;

DROP TRIGGER IF EXISTS whatsapp_provider_completion_requires_confirmation;

DROP TRIGGER IF EXISTS provider_completion_requires_proof;

ALTER TABLE browser_login_pairings ADD COLUMN approval_portfolio_id TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN approval_message_id TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN approval_user_id TEXT REFERENCES users(id);

ALTER TABLE browser_login_pairings ADD COLUMN email_work_id TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN email_user_id TEXT REFERENCES users(id);

ALTER TABLE browser_login_pairings ADD COLUMN email_address TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN email_credential_verified_at_ms INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_state TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN email_public_code TEXT;

ALTER TABLE browser_login_pairings ADD COLUMN email_proof_digest BLOB;

ALTER TABLE browser_login_pairings ADD COLUMN email_proof_expires_at_ms INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_expires_at_ms INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_generation INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_wrong_attempts INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_last_requested_at_ms INTEGER;

ALTER TABLE browser_login_pairings ADD COLUMN email_dispatch_attempted_at_ms INTEGER CHECK((approval_message_id IS NULL AND approval_portfolio_id IS NULL AND approval_message_id IS NULL AND approval_user_id IS NULL) OR (approval_message_id IS NOT NULL AND approval_portfolio_id IS NOT NULL AND approval_message_id IS NOT NULL AND approval_user_id IS NOT NULL)) CHECK((email_work_id IS NULL AND email_work_id IS NULL AND email_user_id IS NULL AND email_address IS NULL AND email_credential_verified_at_ms IS NULL AND email_state IS NULL AND email_public_code IS NULL AND email_proof_digest IS NULL AND email_proof_expires_at_ms IS NULL AND email_expires_at_ms IS NULL AND email_generation IS NULL AND email_wrong_attempts IS NULL AND email_last_requested_at_ms IS NULL AND email_dispatch_attempted_at_ms IS NULL) OR (email_work_id IS NOT NULL AND email_work_id IS NOT NULL AND (length(email_work_id) = 36) AND email_user_id IS NOT NULL AND email_address IS NOT NULL AND email_credential_verified_at_ms IS NOT NULL AND email_state IS NOT NULL AND (email_state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous', 'approved')) AND (email_public_code IS NULL OR length(email_public_code) = 9) AND (email_proof_digest IS NULL OR length(email_proof_digest) = 32) AND email_expires_at_ms IS NOT NULL AND email_generation IS NOT NULL AND (email_generation BETWEEN 1 AND 5) AND email_wrong_attempts IS NOT NULL AND (email_wrong_attempts BETWEEN 0 AND 5) AND email_last_requested_at_ms IS NOT NULL AND ((email_state IN ('sending', 'awaiting_proof') AND email_public_code IS NOT NULL AND email_proof_digest IS NOT NULL AND email_proof_expires_at_ms IS NOT NULL) OR
    (email_state NOT IN ('sending', 'awaiting_proof') AND email_public_code IS NULL AND email_proof_digest IS NULL AND email_proof_expires_at_ms IS NULL))));

UPDATE browser_login_pairings SET approval_portfolio_id=(SELECT portfolio_id FROM browser_login_approvals WHERE pairing_id=browser_login_pairings.id),approval_message_id=(SELECT message_id FROM browser_login_approvals WHERE pairing_id=browser_login_pairings.id),approval_user_id=(SELECT user_id FROM browser_login_approvals WHERE pairing_id=browser_login_pairings.id),email_work_id=(SELECT work_id FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_user_id=(SELECT user_id FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_address=(SELECT email_address FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_credential_verified_at_ms=(SELECT credential_verified_at_ms FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_state=(SELECT state FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_public_code=(SELECT public_code FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_proof_digest=(SELECT proof_digest FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_proof_expires_at_ms=(SELECT proof_expires_at_ms FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_expires_at_ms=(SELECT expires_at_ms FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_generation=(SELECT generation FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_wrong_attempts=(SELECT wrong_attempts FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_last_requested_at_ms=(SELECT last_requested_at_ms FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id),email_dispatch_attempted_at_ms=(SELECT dispatch_attempted_at_ms FROM browser_pairing_email_proofs WHERE pairing_id=browser_login_pairings.id);

ALTER TABLE pending_consent_exchanges ADD COLUMN delivery_phone_number_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN delivery_message_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN delivery_occurred_at_ms INTEGER;

ALTER TABLE pending_consent_exchanges ADD COLUMN delivery_received_at_ms INTEGER;

ALTER TABLE pending_consent_exchanges ADD COLUMN delivery_not_before_ms INTEGER;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_portfolio_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_bsuid TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_phone_number_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_value TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_disclosure_json TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_disclosure_message_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_message_id TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_delivery_key TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_body_sha256 TEXT;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_occurred_at_ms INTEGER;

ALTER TABLE pending_consent_exchanges ADD COLUMN decision_received_at_ms INTEGER CHECK((delivery_message_id IS NULL AND delivery_phone_number_id IS NULL AND delivery_message_id IS NULL AND delivery_occurred_at_ms IS NULL AND delivery_received_at_ms IS NULL AND delivery_not_before_ms IS NULL) OR (delivery_message_id IS NOT NULL AND delivery_phone_number_id IS NOT NULL AND (length(delivery_phone_number_id) BETWEEN 1 AND 32) AND delivery_message_id IS NOT NULL AND (length(delivery_message_id) BETWEEN 1 AND 256) AND delivery_occurred_at_ms IS NOT NULL AND delivery_received_at_ms IS NOT NULL AND delivery_not_before_ms IS NOT NULL AND (delivery_not_before_ms >= delivery_received_at_ms))) CHECK((decision_value IS NULL AND decision_portfolio_id IS NULL AND decision_bsuid IS NULL AND decision_phone_number_id IS NULL AND decision_value IS NULL AND decision_disclosure_json IS NULL AND decision_disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_delivery_key IS NULL AND decision_body_sha256 IS NULL AND decision_occurred_at_ms IS NULL AND decision_received_at_ms IS NULL) OR (decision_value IS NOT NULL AND decision_portfolio_id IS NOT NULL AND decision_bsuid IS NOT NULL AND decision_phone_number_id IS NOT NULL AND (length(decision_phone_number_id) BETWEEN 1 AND 32) AND decision_value IS NOT NULL AND (decision_value IN ('accepted', 'declined')) AND decision_disclosure_json IS NOT NULL AND decision_disclosure_message_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision_delivery_key IS NOT NULL AND (length(decision_delivery_key) BETWEEN 1 AND 256) AND decision_body_sha256 IS NOT NULL AND (length(decision_body_sha256) = 64) AND decision_occurred_at_ms IS NOT NULL AND decision_received_at_ms IS NOT NULL));

UPDATE pending_consent_exchanges SET delivery_phone_number_id=(SELECT phone_number_id FROM pending_consent_delivery WHERE correlation_token=pending_consent_exchanges.correlation_token),delivery_message_id=(SELECT message_id FROM pending_consent_delivery WHERE correlation_token=pending_consent_exchanges.correlation_token),delivery_occurred_at_ms=(SELECT occurred_at_ms FROM pending_consent_delivery WHERE correlation_token=pending_consent_exchanges.correlation_token),delivery_received_at_ms=(SELECT received_at_ms FROM pending_consent_delivery WHERE correlation_token=pending_consent_exchanges.correlation_token),delivery_not_before_ms=(SELECT decision_not_before_ms FROM pending_consent_delivery WHERE correlation_token=pending_consent_exchanges.correlation_token),decision_portfolio_id=(SELECT portfolio_id FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_bsuid=(SELECT bsuid FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_phone_number_id=(SELECT phone_number_id FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_value=(SELECT decision FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_disclosure_json=(SELECT disclosure_json FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_disclosure_message_id=(SELECT disclosure_message_id FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_message_id=(SELECT decision_message_id FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_delivery_key=(SELECT delivery_key FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_body_sha256=(SELECT body_sha256 FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_occurred_at_ms=(SELECT occurred_at_ms FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id),decision_received_at_ms=(SELECT received_at_ms FROM pending_consent_decisions WHERE exchange_id=pending_consent_exchanges.id);

CREATE UNIQUE INDEX browser_login_approvals_identity_0 ON browser_login_pairings(approval_portfolio_id,approval_message_id) WHERE approval_message_id IS NOT NULL;

CREATE UNIQUE INDEX browser_pairing_email_proofs_identity_3 ON browser_login_pairings(email_public_code) WHERE email_work_id IS NOT NULL;

CREATE UNIQUE INDEX browser_pairing_email_proofs_identity_4 ON browser_login_pairings(email_work_id) WHERE email_work_id IS NOT NULL;

CREATE UNIQUE INDEX pending_consent_decisions_identity_0 ON pending_consent_exchanges(decision_portfolio_id,decision_message_id) WHERE decision_value IS NOT NULL;

DROP TABLE browser_login_approvals;

DROP TABLE browser_pairing_email_proofs;

DROP TABLE pending_consent_delivery;

DROP TABLE pending_consent_decisions;

CREATE INDEX pairing_email_pending_health ON browser_login_pairings(email_last_requested_at_ms)
  WHERE email_state IN ('awaiting_delivery', 'sending', 'ambiguous') AND email_work_id IS NOT NULL;

CREATE INDEX pairing_email_rejected_health ON browser_login_pairings(email_last_requested_at_ms) WHERE email_state = 'rejected' AND email_work_id IS NOT NULL;

CREATE INDEX browser_pairing_dispatch_due ON browser_login_pairings(email_dispatch_attempted_at_ms,email_last_requested_at_ms,email_work_id) WHERE email_state='awaiting_delivery' AND email_work_id IS NOT NULL;

CREATE TRIGGER pending_consent_delivery_no_update BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NOT NULL AND (NEW.delivery_phone_number_id IS NOT OLD.delivery_phone_number_id OR NEW.delivery_message_id IS NOT OLD.delivery_message_id OR NEW.delivery_occurred_at_ms IS NOT OLD.delivery_occurred_at_ms OR NEW.delivery_received_at_ms IS NOT OLD.delivery_received_at_ms OR NEW.delivery_not_before_ms IS NOT OLD.delivery_not_before_ms) AND NEW.delivery_message_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_append_only');
END;

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

CREATE TRIGGER pending_consent_decision_settles AFTER UPDATE OF decision_portfolio_id,decision_bsuid,decision_phone_number_id,decision_value,decision_disclosure_json,decision_disclosure_message_id,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NULL AND NEW.decision_value IS NOT NULL
BEGIN
 UPDATE pending_consent_exchanges SET state = NEW.decision_value WHERE id = NEW.id;
END;

CREATE TRIGGER pending_consent_decisions_no_update BEFORE UPDATE OF decision_portfolio_id,decision_bsuid,decision_phone_number_id,decision_value,decision_disclosure_json,decision_disclosure_message_id,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NOT NULL AND (NEW.decision_portfolio_id IS NOT OLD.decision_portfolio_id OR NEW.decision_bsuid IS NOT OLD.decision_bsuid OR NEW.decision_phone_number_id IS NOT OLD.decision_phone_number_id OR NEW.decision_value IS NOT OLD.decision_value OR NEW.decision_disclosure_json IS NOT OLD.decision_disclosure_json OR NEW.decision_disclosure_message_id IS NOT OLD.decision_disclosure_message_id OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision_delivery_key IS NOT OLD.decision_delivery_key OR NEW.decision_body_sha256 IS NOT OLD.decision_body_sha256 OR NEW.decision_occurred_at_ms IS NOT OLD.decision_occurred_at_ms OR NEW.decision_received_at_ms IS NOT OLD.decision_received_at_ms) AND NEW.decision_value IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_append_only');
END;

CREATE TRIGGER browser_login_approval_valid BEFORE UPDATE OF approval_portfolio_id,approval_message_id,approval_user_id ON browser_login_pairings
WHEN OLD.approval_message_id IS NULL AND NEW.approval_message_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p
  JOIN whatsapp_identities AS w ON w.user_id = NEW.approval_user_id
  WHERE p.id = NEW.id AND p.state = 'pending_approval'
    AND w.portfolio_id = NEW.approval_portfolio_id
))
BEGIN
 SELECT RAISE(ABORT, 'browser_login_approval_invalid');
END;

CREATE TRIGGER browser_login_approval_set_ready AFTER UPDATE OF approval_portfolio_id,approval_message_id,approval_user_id ON browser_login_pairings
WHEN OLD.approval_message_id IS NULL AND NEW.approval_message_id IS NOT NULL
BEGIN
 UPDATE browser_login_pairings SET state = 'ready', user_id = NEW.approval_user_id
  WHERE id = NEW.id;
END;

CREATE TRIGGER web_session_requires_pairing BEFORE INSERT ON web_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p WHERE p.id = NEW.pairing_id
    AND p.state = 'consumed' AND p.user_id = NEW.user_id
    AND p.expires_at_ms > NEW.created_at_ms
)
BEGIN
 SELECT RAISE(ABORT, 'web_session_invalid_pairing');
END;

CREATE TRIGGER pending_consent_delivery_requires_attempt BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e WHERE e.correlation_token = NEW.correlation_token
    AND e.state = 'outbound_started' AND e.phone_number_id = NEW.delivery_phone_number_id
    AND (e.disclosure_message_id IS NULL OR e.disclosure_message_id = NEW.delivery_message_id)
    AND NEW.delivery_occurred_at_ms >= (e.created_at_ms / 1000) * 1000 AND NEW.delivery_occurred_at_ms < e.expires_at_ms
    AND NEW.delivery_received_at_ms < e.expires_at_ms
))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_invalid_delivery');
END;

CREATE TRIGGER pending_consent_delivery_opens_decision AFTER UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL
BEGIN
 UPDATE pending_consent_exchanges SET state = 'awaiting_decision', disclosed_at_ms = NEW.delivery_occurred_at_ms,
    decision_not_before_ms = NEW.delivery_not_before_ms,
    disclosure_message_id = NEW.delivery_message_id WHERE correlation_token = NEW.correlation_token;
END;

CREATE TRIGGER pending_consent_rejected_delivery BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL AND (EXISTS (SELECT 1 FROM pending_consent_exchanges
  WHERE correlation_token = NEW.correlation_token AND rejected_at_ms IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_rejected_delivery');
END;

CREATE TRIGGER erasure_fence_browser_login_pairings_insert BEFORE INSERT ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_browser_login_pairings_update BEFORE UPDATE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings')) AND NOT(NEW.id IS OLD.id AND NEW.public_code IS OLD.public_code AND NEW.verifier_digest IS OLD.verifier_digest AND NEW.user_id IS OLD.user_id AND NEW.state IS OLD.state AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.wrong_attempts IS OLD.wrong_attempts AND NEW.last_poll_at_ms IS OLD.last_poll_at_ms AND NEW.minimum_poll_interval_seconds IS OLD.minimum_poll_interval_seconds AND NEW.approval_portfolio_id IS OLD.approval_portfolio_id AND NEW.approval_message_id IS OLD.approval_message_id AND NEW.approval_user_id IS OLD.approval_user_id)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_browser_login_pairings_delete BEFORE DELETE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_insert BEFORE INSERT ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_update BEFORE UPDATE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) OR (EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_insert BEFORE INSERT ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_update BEFORE UPDATE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_delete BEFORE DELETE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'pending_consent_exchanges','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'phone_number_id',OLD."phone_number_id",'initiating_message_id',OLD."initiating_message_id",'initiating_body_sha256',OLD."initiating_body_sha256",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'created_at_ms',OLD."created_at_ms",'disclosed_at_ms',OLD."disclosed_at_ms",'decision_not_before_ms',OLD."decision_not_before_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'rejected_at_ms',OLD."rejected_at_ms",'sandbox_phone',OLD."sandbox_phone",'delivery_phone_number_id',OLD.delivery_phone_number_id,'delivery_message_id',OLD.delivery_message_id,'delivery_occurred_at_ms',OLD.delivery_occurred_at_ms,'delivery_received_at_ms',OLD.delivery_received_at_ms,'delivery_not_before_ms',OLD.delivery_not_before_ms,'decision_portfolio_id',OLD.decision_portfolio_id,'decision_bsuid',OLD.decision_bsuid,'decision_phone_number_id',OLD.decision_phone_number_id,'decision_value',OLD.decision_value,'decision_disclosure_json',OLD.decision_disclosure_json,'decision_disclosure_message_id',OLD.decision_disclosure_message_id,'decision_message_id',OLD.decision_message_id,'decision_delivery_key',OLD.decision_delivery_key,'decision_body_sha256',OLD.decision_body_sha256,'decision_occurred_at_ms',OLD.decision_occurred_at_ms,'decision_received_at_ms',OLD.decision_received_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER provider_attempt_requires_handoff BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.handoff_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM whatsapp_provider_handoffs h JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 WHERE h.id=NEW.handoff_id AND h.pairing_id=NEW.pairing_id AND h.expires_at_ms>NEW.created_at_ms
 AND h.consumed_at_ms IS NULL AND h.decision IS NULL AND e.state='accepted' AND e.expires_at_ms>NEW.created_at_ms
)
BEGIN
 SELECT RAISE(ABORT,'provider_handoff_invalid');
END;

CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM provider_authentication_attempts WHERE id=NEW.id AND handoff_id IS NOT NULL)
AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a
 JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id AND h.pairing_id=a.pairing_id
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN whatsapp_identities w ON w.user_id=NEW.user_id AND w.portfolio_id=e.portfolio_id AND w.bsuid=e.bsuid
 WHERE a.id=NEW.id AND h.decision='confirmed' AND h.review_message_id IS NOT NULL
 AND h.decision_message_id IS NOT NULL AND h.confirmed_at_ms IS NOT NULL AND h.consumed_at_ms IS NULL
 AND h.expires_at_ms>NEW.completed_at_ms AND e.expires_at_ms>NEW.completed_at_ms AND e.state='accepted'
)
BEGIN
 SELECT RAISE(ABORT,'whatsapp_provider_confirmation_invalid');
END;

CREATE TRIGGER provider_completion_requires_proof BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.id AND a.state='verified'
 AND a.expires_at_ms>NEW.completed_at_ms AND p.expires_at_ms>NEW.completed_at_ms AND p.wrong_attempts<5
 AND (NEW.created_user=0 OR (
 a.intent='signup' AND EXISTS(SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') g WHERE g.user_id=NEW.user_id
 AND ((a.handoff_id IS NULL AND g.id=a.id AND g.disclosure_json=a.disclosure_json)
 OR (a.handoff_id IS NOT NULL AND g.id=(SELECT exchange_id FROM whatsapp_provider_handoffs WHERE id=a.handoff_id))))
 AND EXISTS(SELECT 1 FROM users t WHERE t.id=NEW.user_id AND t.trial_started_at_ms=NEW.completed_at_ms)
 AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN
 SELECT RAISE(ABORT,'provider_completion_invalid');
END;

CREATE TRIGGER browser_login_pairings_companions_initial BEFORE INSERT ON browser_login_pairings WHEN NEW.approval_portfolio_id IS NOT NULL OR NEW.approval_message_id IS NOT NULL OR NEW.approval_user_id IS NOT NULL OR NEW.email_work_id IS NOT NULL OR NEW.email_user_id IS NOT NULL OR NEW.email_address IS NOT NULL OR NEW.email_credential_verified_at_ms IS NOT NULL OR NEW.email_state IS NOT NULL OR NEW.email_public_code IS NOT NULL OR NEW.email_proof_digest IS NOT NULL OR NEW.email_proof_expires_at_ms IS NOT NULL OR NEW.email_expires_at_ms IS NOT NULL OR NEW.email_generation IS NOT NULL OR NEW.email_wrong_attempts IS NOT NULL OR NEW.email_last_requested_at_ms IS NOT NULL OR NEW.email_dispatch_attempted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'browser_login_pairings_companions_initial'); END;

CREATE TRIGGER pending_consent_exchanges_companions_initial BEFORE INSERT ON pending_consent_exchanges WHEN NEW.delivery_phone_number_id IS NOT NULL OR NEW.delivery_message_id IS NOT NULL OR NEW.delivery_occurred_at_ms IS NOT NULL OR NEW.delivery_received_at_ms IS NOT NULL OR NEW.delivery_not_before_ms IS NOT NULL OR NEW.decision_portfolio_id IS NOT NULL OR NEW.decision_bsuid IS NOT NULL OR NEW.decision_phone_number_id IS NOT NULL OR NEW.decision_value IS NOT NULL OR NEW.decision_disclosure_json IS NOT NULL OR NEW.decision_disclosure_message_id IS NOT NULL OR NEW.decision_message_id IS NOT NULL OR NEW.decision_delivery_key IS NOT NULL OR NEW.decision_body_sha256 IS NOT NULL OR NEW.decision_occurred_at_ms IS NOT NULL OR NEW.decision_received_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'pending_consent_exchanges_companions_initial'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_authentication_companions',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_authentication_companions';

PRAGMA defer_foreign_keys=OFF;

CREATE TRIGGER pairing_email_erasure_update BEFORE UPDATE OF email_work_id,email_user_id,email_address,email_credential_verified_at_ms,email_state,email_public_code,email_proof_digest,email_proof_expires_at_ms,email_expires_at_ms,email_generation,email_wrong_attempts,email_last_requested_at_ms,email_dispatch_attempted_at_ms ON browser_login_pairings WHEN (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER pairing_email_erasure_delete BEFORE DELETE ON browser_login_pairings WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
