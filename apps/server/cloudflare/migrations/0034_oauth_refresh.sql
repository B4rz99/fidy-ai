-- Snapshot registration policy so registry expiry cannot change a live grant's meaning.
ALTER TABLE oauth_connections ADD COLUMN refresh_allowed INTEGER NOT NULL DEFAULT 0 CHECK (refresh_allowed IN (0,1));
UPDATE oauth_connections SET refresh_allowed = EXISTS (SELECT 1 FROM oauth_public_clients c,json_each(c.metadata_json,'$.grant_types') t WHERE c.id = client_id AND t.value = 'refresh_token');
CREATE TRIGGER oauth_refresh_policy_immutable BEFORE UPDATE OF refresh_allowed ON oauth_connections
BEGIN SELECT RAISE(ABORT,'oauth_immutable'); END;
-- Credentials retain their own narrowing scope and exact stable User binding.
ALTER TABLE oauth_access_credentials ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["read"]';
UPDATE oauth_access_credentials SET scopes_json = (SELECT scopes_json FROM oauth_connections WHERE id = connection_id);
ALTER TABLE oauth_refresh_credentials ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE oauth_refresh_credentials ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["read"]';
UPDATE oauth_refresh_credentials SET user_id = (SELECT user_id FROM oauth_connections WHERE id = connection_id), scopes_json = (SELECT scopes_json FROM oauth_connections WHERE id = connection_id);
CREATE TRIGGER oauth_refresh_subject BEFORE INSERT ON oauth_refresh_credentials
WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM oauth_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT,'oauth_subject'); END;
CREATE TABLE oauth_refresh_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  consumed_credential_id TEXT NOT NULL UNIQUE REFERENCES oauth_refresh_credentials(id),
  issued_credential_id TEXT NOT NULL UNIQUE REFERENCES oauth_refresh_credentials(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER oauth_refresh_events_no_update BEFORE UPDATE ON oauth_refresh_events
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;
CREATE TRIGGER oauth_refresh_events_no_delete BEFORE DELETE ON oauth_refresh_events
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;
-- Replay evidence never stores the presented proof or replacement bearer.
CREATE TABLE oauth_revocation_consents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL UNIQUE REFERENCES oauth_connections(id),
  reason TEXT NOT NULL CHECK (reason = 'refresh_replay'),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER oauth_revocation_consents_no_update BEFORE UPDATE ON oauth_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER oauth_revocation_consents_no_delete BEFORE DELETE ON oauth_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
