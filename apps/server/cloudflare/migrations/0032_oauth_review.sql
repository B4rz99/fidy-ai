-- Bootstrap metadata only. No OAuth grant, code or credential authority is installed.
CREATE TABLE oauth_public_clients (
  id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 16384),
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL
);
CREATE INDEX oauth_clients_unused ON oauth_public_clients(last_used_at_ms);
CREATE TRIGGER oauth_registry_capacity BEFORE INSERT ON oauth_public_clients
WHEN (SELECT count(*) FROM oauth_public_clients) >= 10000
BEGIN SELECT RAISE(ABORT, 'oauth_capacity'); END;

CREATE TABLE oauth_review_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_public_clients(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL CHECK (length(request_json) <= 16384),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  user_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'cancelled')) DEFAULT 'pending'
);
CREATE INDEX oauth_review_source ON oauth_review_requests(source_digest, state, expires_at_ms);
CREATE INDEX oauth_review_user ON oauth_review_requests(user_id, state, expires_at_ms);
CREATE INDEX oauth_review_expiry ON oauth_review_requests(expires_at_ms);
CREATE TRIGGER oauth_source_capacity BEFORE INSERT ON oauth_review_requests
WHEN (SELECT count(*) FROM oauth_review_requests WHERE source_digest = NEW.source_digest AND state = 'pending' AND expires_at_ms > NEW.created_at_ms) >= 5
BEGIN SELECT RAISE(ABORT, 'oauth_capacity'); END;
