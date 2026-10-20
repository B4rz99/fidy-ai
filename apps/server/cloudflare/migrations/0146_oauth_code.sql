PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS oauth_connection_immutable;

DROP TRIGGER IF EXISTS oauth_refresh_policy_immutable;

DROP TRIGGER IF EXISTS oauth_refresh_subject;

DROP TRIGGER IF EXISTS erasure_fence_oauth_connections_insert;

DROP TRIGGER IF EXISTS erasure_fence_oauth_connections_update;

DROP TRIGGER IF EXISTS erasure_fence_oauth_connections_delete;

DROP TRIGGER IF EXISTS erasure_fence_oauth_codes_insert;

DROP TRIGGER IF EXISTS erasure_fence_oauth_codes_update;

DROP TRIGGER IF EXISTS erasure_fence_oauth_codes_delete;

ALTER TABLE oauth_connections ADD COLUMN code_digest BLOB;

ALTER TABLE oauth_connections ADD COLUMN code_challenge TEXT;

ALTER TABLE oauth_connections ADD COLUMN code_expires_at_ms INTEGER;

ALTER TABLE oauth_connections ADD COLUMN code_consumed_at_ms INTEGER CHECK((code_digest IS NULL AND code_digest IS NULL AND code_challenge IS NULL AND code_expires_at_ms IS NULL AND code_consumed_at_ms IS NULL) OR (code_digest IS NOT NULL AND code_digest IS NOT NULL AND (length(code_digest) = 32) AND code_challenge IS NOT NULL AND code_expires_at_ms IS NOT NULL));

UPDATE oauth_connections SET code_digest=(SELECT digest FROM oauth_codes WHERE connection_id=oauth_connections.id),code_challenge=(SELECT challenge FROM oauth_codes WHERE connection_id=oauth_connections.id),code_expires_at_ms=(SELECT expires_at_ms FROM oauth_codes WHERE connection_id=oauth_connections.id),code_consumed_at_ms=(SELECT consumed_at_ms FROM oauth_codes WHERE connection_id=oauth_connections.id);

CREATE UNIQUE INDEX oauth_codes_identity_1 ON oauth_connections(code_digest) WHERE code_digest IS NOT NULL;

DROP TABLE oauth_codes;

CREATE TRIGGER oauth_connection_immutable BEFORE UPDATE OF user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms ON oauth_connections
BEGIN
 SELECT RAISE(ABORT,'oauth_immutable');
END;

CREATE TRIGGER oauth_refresh_policy_immutable BEFORE UPDATE OF refresh_allowed ON oauth_connections
BEGIN
 SELECT RAISE(ABORT,'oauth_immutable');
END;

CREATE TRIGGER oauth_refresh_subject BEFORE INSERT ON oauth_refresh_credentials
WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM oauth_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT,'oauth_subject');
END;

CREATE TRIGGER erasure_fence_oauth_connections_insert BEFORE INSERT ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_oauth_connections_update BEFORE UPDATE ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_oauth_connections_delete BEFORE DELETE ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER oauth_connections_companions_initial BEFORE INSERT ON oauth_connections WHEN NEW.code_digest IS NOT NULL OR NEW.code_challenge IS NOT NULL OR NEW.code_expires_at_ms IS NOT NULL OR NEW.code_consumed_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'oauth_connections_companions_initial'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_oauth_code',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_oauth_code';

PRAGMA defer_foreign_keys=OFF;
