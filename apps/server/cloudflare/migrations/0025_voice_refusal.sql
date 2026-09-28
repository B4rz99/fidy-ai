-- One bounded, non-retriable acknowledgement attempt for each unusable authenticated voice message.
-- Claim before provider I/O: an ambiguous send can lose the reply but cannot duplicate it.
CREATE TABLE hosted_voice_refusals (
  portfolio_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'accepted', 'failed')),
  PRIMARY KEY (portfolio_id, message_id)
);
CREATE INDEX hosted_voice_refusals_user_window
  ON hosted_voice_refusals (user_id, claimed_at_ms);
