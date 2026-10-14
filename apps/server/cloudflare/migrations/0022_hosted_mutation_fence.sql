-- A hosted mutation's durable commit receipt and its pending-Turn guard are one D1 unit
-- with the canonical owner write and its Audit. The CHECK rejects a late commit after
-- recovery; the primary key prevents a replacement attempt from repeating a committed call.
CREATE TABLE hosted_mutation_commits (
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  PRIMARY KEY (turn_id, tool_call_id),
  FOREIGN KEY (turn_id) REFERENCES hosted_turns(id) ON DELETE CASCADE
) STRICT;
