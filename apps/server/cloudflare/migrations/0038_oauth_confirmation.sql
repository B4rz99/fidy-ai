-- Public references are not bearer authority. Inputs/effects are private and expire after five minutes.
CREATE TABLE oauth_operation_intents (
  reference TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) <= 16384),
  input_digest BLOB NOT NULL CHECK(length(input_digest) = 32),
  binding_json TEXT NOT NULL,
  disclosure_revision TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 300000)
);
CREATE INDEX oauth_operation_intents_expiry ON oauth_operation_intents(expires_at_ms);
CREATE INDEX oauth_operation_intents_user ON oauth_operation_intents(user_id);
CREATE TRIGGER oauth_operation_intents_capacity BEFORE INSERT ON oauth_operation_intents
WHEN (SELECT count(*) FROM oauth_operation_intents WHERE user_id = NEW.user_id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'oauth_confirmation_capacity');
END;
CREATE TABLE oauth_confirmation_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  accepted INTEGER NOT NULL CHECK(accepted = 1)
);
