-- The browser decision is an additional single-use prerequisite, not a client assertion.
ALTER TABLE oauth_operation_intents ADD COLUMN browser_approved_at_ms INTEGER;
ALTER TABLE oauth_operation_intents ADD COLUMN browser_session_id TEXT REFERENCES web_sessions(id);
