CREATE INDEX connection_attempt_retention ON connection_attempts(expires_at_ms, id);
