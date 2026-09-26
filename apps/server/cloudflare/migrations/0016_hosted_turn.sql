-- Hosted Agent Sessions are User-owned. D1 is the sole authority for Turn outcomes and exact
-- retained Transcript evidence; the per-User DO coordinates execution, not storage.
CREATE TABLE hosted_agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  consent_basis_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_activity_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','idle-ended','revoked')),
  UNIQUE (user_id, id)
) STRICT;
CREATE INDEX hosted_agent_sessions_by_user ON hosted_agent_sessions(user_id, started_at_ms DESC);
CREATE TABLE hosted_turns (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','interrupted')),
  failure_reason TEXT CHECK (failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed')),
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  UNIQUE (user_id, id),
  CHECK ((status = 'pending' AND terminal_at_ms IS NULL AND failure_reason IS NULL) OR
         (status = 'failed' AND terminal_at_ms >= started_at_ms AND failure_reason IS NOT NULL) OR
         (status IN ('completed','interrupted') AND terminal_at_ms >= started_at_ms AND failure_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX hosted_turns_one_pending ON hosted_turns(user_id) WHERE status = 'pending';
CREATE INDEX hosted_turns_by_user_session ON hosted_turns(user_id, hosted_session_id, started_at_ms);
CREATE TRIGGER hosted_turns_terminal_once BEFORE UPDATE ON hosted_turns
WHEN OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.hosted_session_id <> OLD.hosted_session_id OR NEW.started_at_ms <> OLD.started_at_ms
  OR NEW.status = 'pending'
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_once'); END;
CREATE TABLE transcript_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','assistant','failed','interrupted')),
  occurred_at_ms INTEGER NOT NULL,
  text TEXT,
  failure_reason TEXT,
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id),
  CHECK ((kind IN ('user','assistant') AND text IS NOT NULL AND failure_reason IS NULL) OR
         (kind = 'failed' AND text IS NULL AND failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed')) OR
         (kind = 'interrupted' AND text IS NULL AND failure_reason IS NULL))
) STRICT;
CREATE INDEX transcript_entries_by_session ON transcript_entries(user_id, hosted_session_id, sequence);
CREATE UNIQUE INDEX transcript_one_user ON transcript_entries(turn_id) WHERE kind = 'user';
CREATE UNIQUE INDEX transcript_one_terminal ON transcript_entries(turn_id) WHERE kind IN ('assistant','failed','interrupted');
-- A terminal status cannot be committed without its matching exact or metadata-only marker.
CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason))
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required'); END;
CREATE TRIGGER transcript_no_update BEFORE UPDATE ON transcript_entries
BEGIN SELECT RAISE(ABORT, 'transcript_append_only'); END;
CREATE TRIGGER transcript_no_delete BEFORE DELETE ON transcript_entries
BEGIN SELECT RAISE(ABORT, 'transcript_append_only'); END;
-- A concurrent Consent withdrawal cannot admit a Turn, even if preflight saw a grant.
-- At most fifty paid inference attempts per User and UTC day, even across new Sessions.
CREATE INDEX hosted_turns_by_user_day ON hosted_turns(user_id, started_at_ms);
CREATE TRIGGER hosted_turn_daily_budget BEFORE INSERT ON hosted_turns
WHEN (SELECT COUNT(*) FROM hosted_turns WHERE user_id = NEW.user_id
      AND started_at_ms >= (NEW.started_at_ms / 86400000) * 86400000
      AND started_at_ms < ((NEW.started_at_ms / 86400000) + 1) * 86400000) >= 50
BEGIN SELECT RAISE(ABORT, 'hosted_turn_daily_budget'); END;
CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'hosted_turn_consent_required'); END;
