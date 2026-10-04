-- Commercial consumption is separate from security admission and provider spend.
CREATE TABLE commercial_allowance_consumptions (
  user_id TEXT NOT NULL REFERENCES users(id),
  allowance TEXT NOT NULL CHECK (allowance IN ('forwarded_email','media_submission','hosted_history_turn','canonical_call')),
  identity TEXT NOT NULL CHECK (length(identity) BETWEEN 1 AND 128),
  period_start_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  units INTEGER NOT NULL CHECK (units IN (0,1)),
  PRIMARY KEY (user_id, allowance, identity)
);
CREATE INDEX commercial_allowance_period ON commercial_allowance_consumptions(user_id, allowance, period_start_ms, units);
CREATE TABLE commercial_allowance_assertions (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT commercial_authority_required CHECK (valid = 1)
);
CREATE TRIGGER commercial_allowance_capacity BEFORE INSERT ON commercial_allowance_consumptions
WHEN NEW.units = 1 AND NOT EXISTS (
  SELECT 1 FROM commercial_allowance_consumptions WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND identity = NEW.identity
) AND (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions
 WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND period_start_ms = NEW.period_start_ms) >=
 CASE NEW.allowance WHEN 'forwarded_email' THEN 50 WHEN 'media_submission' THEN 2 WHEN 'hosted_history_turn' THEN 2 WHEN 'canonical_call' THEN 50 END
BEGIN SELECT RAISE(ABORT, 'commercial_quota_exhausted'); END;

CREATE TABLE canonical_request_replays (
  user_id TEXT NOT NULL REFERENCES users(id),
  retry_key_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  identity TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','completed')),
  status INTEGER,
  body TEXT CHECK (length(CAST(body AS BLOB)) <= 1048576),
  content_type TEXT,
  CHECK (expires_at_ms = accepted_at_ms + 86400000),
  PRIMARY KEY (user_id, retry_key_digest),
  CHECK ((state = 'pending' AND status IS NULL AND body IS NULL) OR (state = 'completed' AND status IS NOT NULL AND body IS NOT NULL))
);
CREATE INDEX canonical_request_replay_expiry ON canonical_request_replays(expires_at_ms);
