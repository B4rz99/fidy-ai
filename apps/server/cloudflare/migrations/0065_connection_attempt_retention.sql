-- Bound the independent global retention scan without requiring User activity.
CREATE INDEX connection_attempt_retention ON connection_attempts(expires_at_ms, id);
