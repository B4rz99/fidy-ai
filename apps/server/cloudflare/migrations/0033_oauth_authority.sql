-- OAuth authority is independent of PAT and browser session lifecycle.
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  claimed_client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource = 'https://api.fidyapp.com/mcp'),
  scopes_json TEXT NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > approved_at_ms),
  revoked_at_ms INTEGER
) STRICT;
CREATE INDEX oauth_connections_user ON oauth_connections(user_id, expires_at_ms);
CREATE TRIGGER oauth_connection_immutable BEFORE UPDATE OF user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms ON oauth_connections
BEGIN SELECT RAISE(ABORT,'oauth_immutable'); END;
CREATE TABLE oauth_grant_consents (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL UNIQUE REFERENCES oauth_connections(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  disclosure_revision TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER oauth_grant_consents_no_update BEFORE UPDATE ON oauth_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER oauth_grant_consents_no_delete BEFORE DELETE ON oauth_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE oauth_codes (
  digest BLOB PRIMARY KEY NOT NULL CHECK (length(digest) = 32),
  connection_id TEXT NOT NULL UNIQUE REFERENCES oauth_connections(id),
  challenge TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) STRICT;
CREATE TABLE oauth_access_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  digest BLOB NOT NULL UNIQUE CHECK (length(digest) = 32),
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms)
) STRICT;
CREATE TABLE oauth_refresh_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  digest BLOB NOT NULL UNIQUE CHECK (length(digest) = 32),
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
  consumed_at_ms INTEGER
) STRICT;
-- Reuse the canonical metadata ledger and its stable-User budget; no OAuth audit stream.
ALTER TABLE pat_audit ADD COLUMN oauth_connection_id TEXT REFERENCES oauth_connections(id);
ALTER TABLE pat_audit ADD COLUMN oauth_credential_id TEXT REFERENCES oauth_access_credentials(id);
CREATE TABLE oauth_atomic_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
