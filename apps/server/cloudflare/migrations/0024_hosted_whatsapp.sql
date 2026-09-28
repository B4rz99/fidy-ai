-- D1 migrations run in one implicit transaction. Rebuild the two existing CHECK constraints
-- rather than editing an already-applied migration; FK validation resumes at transaction end.
-- Dropping the referenced Turn table fires its one ON DELETE CASCADE child even with deferred
-- checks, so preserve and restore the fenced mutation receipts within this migration.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER transcript_retention_guard;
DROP TRIGGER hosted_delivery_proposals_no_update;
CREATE TABLE hosted_mutation_commits_preserved AS SELECT * FROM hosted_mutation_commits;

CREATE TABLE hosted_turns_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','interrupted')),
  failure_reason TEXT CHECK (failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed','DeliveryUnconfirmed')),
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  UNIQUE (user_id, id),
  CHECK ((status = 'pending' AND terminal_at_ms IS NULL AND failure_reason IS NULL) OR
         (status = 'failed' AND terminal_at_ms >= started_at_ms AND failure_reason IS NOT NULL) OR
         (status IN ('completed','interrupted') AND terminal_at_ms >= started_at_ms AND failure_reason IS NULL))
) STRICT;
INSERT INTO hosted_turns_next
  (id, user_id, hosted_session_id, started_at_ms, terminal_at_ms, status, failure_reason)
SELECT id, user_id, hosted_session_id, started_at_ms, terminal_at_ms, status, failure_reason
FROM hosted_turns;
DROP TABLE hosted_turns;
ALTER TABLE hosted_turns_next RENAME TO hosted_turns;
CREATE UNIQUE INDEX hosted_turns_one_pending ON hosted_turns(user_id) WHERE status = 'pending';
CREATE INDEX hosted_turns_by_user_session ON hosted_turns(user_id, hosted_session_id, started_at_ms);
CREATE INDEX hosted_turns_by_user_day ON hosted_turns(user_id, started_at_ms);
CREATE TRIGGER hosted_turns_begin_pending BEFORE INSERT ON hosted_turns
WHEN NEW.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'hosted_turn_must_begin_pending'); END;
CREATE TRIGGER hosted_turns_terminal_once BEFORE UPDATE ON hosted_turns
WHEN OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.hosted_session_id <> OLD.hosted_session_id OR NEW.started_at_ms <> OLD.started_at_ms
  OR NEW.status = 'pending'
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_once'); END;
CREATE TRIGGER hosted_turn_daily_budget BEFORE INSERT ON hosted_turns
WHEN (SELECT COUNT(*) FROM hosted_turns WHERE user_id = NEW.user_id
      AND started_at_ms >= (NEW.started_at_ms / 86400000) * 86400000
      AND started_at_ms < ((NEW.started_at_ms / 86400000) + 1) * 86400000) >= 50
BEGIN SELECT RAISE(ABORT, 'hosted_turn_daily_budget'); END;
CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'hosted_turn_consent_required'); END;
INSERT INTO hosted_mutation_commits
  (turn_id, tool_call_id, user_id, committed_at_ms, valid)
SELECT turn_id, tool_call_id, user_id, committed_at_ms, valid
FROM hosted_mutation_commits_preserved;
DROP TABLE hosted_mutation_commits_preserved;
CREATE TRIGGER hosted_delivery_proposals_no_update BEFORE UPDATE ON hosted_delivery_proposals
WHEN NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id
    AND user_id = OLD.user_id AND status = 'pending')
BEGIN SELECT RAISE(ABORT, 'hosted_delivery_immutable'); END;

CREATE TABLE transcript_entries_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','assistant','tool_call','tool_result','failed','interrupted')),
  occurred_at_ms INTEGER NOT NULL,
  text TEXT,
  failure_reason TEXT,
  iteration INTEGER,
  tool_call_id TEXT,
  operation TEXT,
  input_json TEXT,
  outcome_json TEXT,
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id),
  CHECK ((kind IN ('user','assistant') AND text IS NOT NULL AND failure_reason IS NULL
           AND tool_call_id IS NULL AND operation IS NULL AND input_json IS NULL AND outcome_json IS NULL) OR
         (kind = 'tool_call' AND text IS NULL AND failure_reason IS NULL AND iteration BETWEEN 1 AND 32
           AND tool_call_id IS NOT NULL AND operation IS NOT NULL AND input_json IS NOT NULL AND outcome_json IS NULL) OR
         (kind = 'tool_result' AND text IS NULL AND failure_reason IS NULL AND iteration BETWEEN 1 AND 32
           AND tool_call_id IS NOT NULL AND operation IS NOT NULL AND input_json IS NULL AND outcome_json IS NOT NULL) OR
         (kind = 'failed' AND text IS NULL AND failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed','DeliveryUnconfirmed')) OR
         (kind = 'interrupted' AND text IS NULL AND failure_reason IS NULL))
) STRICT;
-- The deployed 0016 schema predates tool evidence; the new metadata columns remain NULL for prior entries.
INSERT INTO transcript_entries_next
  (sequence, id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text, failure_reason)
SELECT sequence, id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text, failure_reason
FROM transcript_entries;
DROP TABLE transcript_entries;
ALTER TABLE transcript_entries_next RENAME TO transcript_entries;
CREATE INDEX transcript_entries_by_session ON transcript_entries(user_id, hosted_session_id, sequence);
CREATE UNIQUE INDEX transcript_one_user ON transcript_entries(turn_id) WHERE kind = 'user';
CREATE UNIQUE INDEX transcript_tool_call ON transcript_entries(turn_id, tool_call_id) WHERE kind = 'tool_call';
CREATE UNIQUE INDEX transcript_tool_result ON transcript_entries(turn_id, tool_call_id) WHERE kind = 'tool_result';
CREATE UNIQUE INDEX transcript_one_terminal ON transcript_entries(turn_id) WHERE kind IN ('assistant','failed','interrupted');
CREATE TRIGGER transcript_no_update BEFORE UPDATE ON transcript_entries
BEGIN SELECT RAISE(ABORT, 'transcript_append_only'); END;
CREATE TRIGGER transcript_retention_guard BEFORE DELETE ON transcript_entries
WHEN NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id AND user_id = OLD.user_id
  AND status <> 'pending' AND terminal_at_ms < (unixepoch('now') * 1000 - 2592000000))
AND NOT EXISTS (SELECT 1 FROM hosted_compacted_conversations AS c
  JOIN hosted_turns AS t ON t.id = OLD.turn_id AND t.user_id = OLD.user_id
  WHERE c.user_id = OLD.user_id AND c.hosted_session_id = OLD.hosted_session_id
    AND c.through_sequence >= OLD.sequence AND t.status <> 'pending')
BEGIN SELECT RAISE(ABORT, 'transcript_retention_not_due'); END;

-- Authenticated inbound evidence is metadata only; exact text remains exclusively in the Transcript.
CREATE TABLE hosted_whatsapp_inbound (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  business_phone_number_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id),
  UNIQUE (user_id, turn_id),
  UNIQUE (portfolio_id, message_id),
  CHECK (received_at_ms >= occurred_at_ms - 300000)
) STRICT;
CREATE INDEX hosted_whatsapp_inbound_user ON hosted_whatsapp_inbound(user_id, turn_id);
CREATE TRIGGER hosted_whatsapp_inbound_no_update BEFORE UPDATE ON hosted_whatsapp_inbound
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_inbound_immutable'); END;
-- Identity-only outbox is created with the Pending Turn and survives webhook/Queue interruption.
CREATE TABLE hosted_whatsapp_outbox (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  offered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_whatsapp_inbound(user_id, turn_id)
) STRICT;
CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_whatsapp_outbox(offered_at_ms, created_at_ms);

-- The visible answer is only a proposal until Kapso attests delivery. A send is never retried
-- once started: an ambiguous HTTP outcome may have been displayed to the User.
CREATE TABLE hosted_whatsapp_delivery (
  turn_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  correlation_token TEXT NOT NULL UNIQUE,
  business_phone_number_id TEXT NOT NULL,
  proposed_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending','accepted','ambiguous','rejected','delivered','unconfirmed')),
  provider_message_id TEXT,
  delivered_at_ms INTEGER,
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_whatsapp_inbound(user_id, turn_id),
  CHECK ((state = 'delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at_ms IS NULL))
) STRICT;
CREATE TRIGGER hosted_whatsapp_delivery_identity_immutable BEFORE UPDATE ON hosted_whatsapp_delivery
WHEN NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.correlation_token <> OLD.correlation_token
  OR NEW.business_phone_number_id <> OLD.business_phone_number_id
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
  OR OLD.state IN ('rejected','delivered','unconfirmed')
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_delivery_immutable'); END;
CREATE TABLE hosted_whatsapp_delivery_events (
  correlation_token TEXT NOT NULL REFERENCES hosted_whatsapp_delivery(correlation_token),
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','failed')),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (correlation_token, provider_message_id, status, occurred_at_ms)
) STRICT;
CREATE TRIGGER hosted_whatsapp_delivery_event_immutable BEFORE UPDATE ON hosted_whatsapp_delivery_events
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_event_immutable'); END;

CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required'); END;
-- The replacement tables and all references are restored before foreign-key checks resume.
PRAGMA defer_foreign_keys=OFF;
