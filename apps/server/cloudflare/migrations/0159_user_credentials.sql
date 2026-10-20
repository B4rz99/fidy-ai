DROP TRIGGER browser_login_approval_valid;

DROP TRIGGER erasure_fence_pending_consent_exchanges_insert;

DROP TRIGGER erasure_fence_pending_consent_exchanges_update;

DROP TRIGGER erasure_fence_pending_consent_exchanges_delete;

DROP TRIGGER erasure_preserve_pending_consent_exchanges_delete;

DROP TRIGGER whatsapp_provider_completion_requires_confirmation;

DROP TRIGGER provider_completion_requires_proof;

ALTER TABLE users ADD COLUMN verified_email_address TEXT COLLATE NOCASE CHECK(verified_email_address IS NULL OR verified_email_address=lower(trim(verified_email_address)));

ALTER TABLE users ADD COLUMN email_verified_at_ms INTEGER CHECK((verified_email_address IS NULL)=(email_verified_at_ms IS NULL));

UPDATE users SET (verified_email_address,email_verified_at_ms)=(SELECT email_address,verified_at_ms FROM verified_email_credentials WHERE user_id=users.id) WHERE EXISTS(SELECT 1 FROM verified_email_credentials WHERE user_id=users.id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_user_credentials', (SELECT COUNT(*) FROM verified_email_credentials)=(SELECT COUNT(*) FROM users WHERE verified_email_address IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE verified_email_credentials;

CREATE TRIGGER verified_email_credentials_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.verified_email_address IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER verified_email_credentials_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.verified_email_address IS NOT OLD.verified_email_address OR NEW.email_verified_at_ms IS NOT OLD.email_verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.verified_email_address IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.verified_email_address IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER verified_email_credentials_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.verified_email_address IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

ALTER TABLE users ADD COLUMN recovery_code_digest BLOB CHECK(recovery_code_digest IS NULL OR length(recovery_code_digest)=32);

ALTER TABLE users ADD COLUMN recovery_created_at_ms INTEGER;

ALTER TABLE users ADD COLUMN recovery_consumed_at_ms INTEGER;

ALTER TABLE users ADD COLUMN recovery_revision INTEGER CHECK((recovery_code_digest IS NULL AND recovery_created_at_ms IS NULL AND recovery_consumed_at_ms IS NULL AND recovery_revision IS NULL) OR (recovery_code_digest IS NOT NULL AND recovery_created_at_ms IS NOT NULL AND recovery_revision IS NOT NULL));

UPDATE users SET (recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision)=(SELECT code_digest,created_at_ms,consumed_at_ms,revision FROM backup_recovery_credentials WHERE user_id=users.id) WHERE EXISTS(SELECT 1 FROM backup_recovery_credentials WHERE user_id=users.id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_user_credentials', (SELECT COUNT(*) FROM backup_recovery_credentials)=(SELECT COUNT(*) FROM users WHERE recovery_code_digest IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE backup_recovery_credentials;

CREATE TRIGGER backup_recovery_credentials_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.recovery_code_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER backup_recovery_credentials_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.recovery_code_digest IS NOT OLD.recovery_code_digest OR NEW.recovery_created_at_ms IS NOT OLD.recovery_created_at_ms OR NEW.recovery_consumed_at_ms IS NOT OLD.recovery_consumed_at_ms OR NEW.recovery_revision IS NOT OLD.recovery_revision) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.recovery_code_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.recovery_code_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER backup_recovery_credentials_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.recovery_code_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

ALTER TABLE users ADD COLUMN whatsapp_portfolio_id TEXT;

ALTER TABLE users ADD COLUMN whatsapp_bsuid TEXT;

ALTER TABLE users ADD COLUMN whatsapp_verified_at_ms INTEGER CHECK((whatsapp_portfolio_id IS NULL AND whatsapp_bsuid IS NULL AND whatsapp_verified_at_ms IS NULL) OR (whatsapp_portfolio_id IS NOT NULL AND whatsapp_bsuid IS NOT NULL AND whatsapp_verified_at_ms IS NOT NULL));

UPDATE users SET (whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms)=(SELECT portfolio_id,bsuid,verified_at_ms FROM whatsapp_identities WHERE user_id=users.id) WHERE EXISTS(SELECT 1 FROM whatsapp_identities WHERE user_id=users.id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_user_credentials', (SELECT COUNT(*) FROM whatsapp_identities)=(SELECT COUNT(*) FROM users WHERE whatsapp_portfolio_id IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE whatsapp_identities;

CREATE TRIGGER whatsapp_identities_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER whatsapp_identities_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.whatsapp_portfolio_id IS NOT OLD.whatsapp_portfolio_id OR NEW.whatsapp_bsuid IS NOT OLD.whatsapp_bsuid OR NEW.whatsapp_verified_at_ms IS NOT OLD.whatsapp_verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER whatsapp_identities_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

ALTER TABLE users ADD COLUMN route_portfolio_id TEXT;

ALTER TABLE users ADD COLUMN route_bsuid TEXT;

ALTER TABLE users ADD COLUMN route_phone_number_id TEXT;

ALTER TABLE users ADD COLUMN route_verified_at_ms INTEGER CHECK((route_portfolio_id IS NULL AND route_bsuid IS NULL AND route_phone_number_id IS NULL AND route_verified_at_ms IS NULL) OR (route_portfolio_id IS NOT NULL AND route_bsuid IS NOT NULL AND route_phone_number_id IS NOT NULL AND route_verified_at_ms IS NOT NULL));

UPDATE users SET (route_portfolio_id,route_bsuid,route_phone_number_id,route_verified_at_ms)=(SELECT portfolio_id,bsuid,business_phone_number_id,verified_at_ms FROM insight_whatsapp_routes WHERE user_id=users.id) WHERE EXISTS(SELECT 1 FROM insight_whatsapp_routes WHERE user_id=users.id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_user_credentials', (SELECT COUNT(*) FROM insight_whatsapp_routes)=(SELECT COUNT(*) FROM users WHERE route_portfolio_id IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE insight_whatsapp_routes;

CREATE TRIGGER insight_whatsapp_routes_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_whatsapp_routes_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.route_portfolio_id IS NOT OLD.route_portfolio_id OR NEW.route_bsuid IS NOT OLD.route_bsuid OR NEW.route_phone_number_id IS NOT OLD.route_phone_number_id OR NEW.route_verified_at_ms IS NOT OLD.route_verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_whatsapp_routes_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER insight_whatsapp_routes_field_preserve_update BEFORE UPDATE ON users WHEN OLD.route_portfolio_id IS NOT NULL AND NEW.route_portfolio_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_whatsapp_routes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'portfolio_id',OLD.route_portfolio_id,'bsuid',OLD.route_bsuid,'business_phone_number_id',OLD.route_phone_number_id,'verified_at_ms',OLD.route_verified_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER insight_whatsapp_routes_field_preserve_delete BEFORE DELETE ON users WHEN OLD.route_portfolio_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_whatsapp_routes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'portfolio_id',OLD.route_portfolio_id,'bsuid',OLD.route_bsuid,'business_phone_number_id',OLD.route_phone_number_id,'verified_at_ms',OLD.route_verified_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE UNIQUE INDEX users_verified_email ON users(verified_email_address) WHERE verified_email_address IS NOT NULL;

CREATE INDEX users_recovery_digest ON users(recovery_code_digest) WHERE recovery_code_digest IS NOT NULL;

CREATE UNIQUE INDEX users_whatsapp_identity ON users(whatsapp_portfolio_id,whatsapp_bsuid) WHERE whatsapp_portfolio_id IS NOT NULL;

CREATE TRIGGER browser_login_approval_valid BEFORE UPDATE OF approval_portfolio_id,approval_message_id,approval_user_id ON browser_login_pairings
WHEN OLD.approval_message_id IS NULL AND NEW.approval_message_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p
  JOIN (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) AS w ON w.user_id = NEW.approval_user_id
  WHERE p.id = NEW.id AND p.state = 'pending_approval'
    AND w.portfolio_id = NEW.approval_portfolio_id
))
BEGIN
 SELECT RAISE(ABORT, 'browser_login_approval_invalid');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_insert BEFORE INSERT ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_update BEFORE UPDATE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

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

CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM provider_authentication_attempts WHERE id=NEW.id AND handoff_id IS NOT NULL)
AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a
 JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id AND h.pairing_id=a.pairing_id
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w ON w.user_id=NEW.user_id AND w.portfolio_id=e.portfolio_id AND w.bsuid=e.bsuid
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
 AND EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,recovery_code_digest AS code_digest,recovery_created_at_ms AS created_at_ms,recovery_consumed_at_ms AS consumed_at_ms,recovery_revision AS revision FROM users WHERE recovery_code_digest IS NOT NULL) r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN
 SELECT RAISE(ABORT,'provider_completion_invalid');
END;
