-- Transaction-owned invalidation is atomic with every change to effective financial facts.
CREATE TABLE transaction_fact_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  first_captured_at TEXT NOT NULL,
  time_zone TEXT NOT NULL
) STRICT;
INSERT INTO transaction_fact_state (user_id, revision, first_captured_at, time_zone)
SELECT t.user_id, 1, MIN(t.created_at), COALESCE(
  (SELECT a.time_zone FROM source_attestations a JOIN transactions captured
    ON captured.user_id = a.user_id AND captured.id = a.transaction_id
    WHERE a.user_id = t.user_id ORDER BY captured.created_at, a.created_at, a.id LIMIT 1),
  (SELECT time_zone FROM users WHERE id = t.user_id))
FROM transactions t GROUP BY t.user_id;
CREATE TRIGGER transaction_fact_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO transaction_fact_state SELECT NEW.user_id, 1, NEW.created_at, time_zone FROM users WHERE id = NEW.user_id
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER transaction_fact_update AFTER UPDATE ON transactions BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER transaction_fact_delete AFTER DELETE ON transactions BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = OLD.user_id;
END;
CREATE TRIGGER transaction_fact_attestation AFTER INSERT ON source_attestations BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1,
    time_zone = CASE WHEN NEW.transaction_id = (SELECT id FROM transactions WHERE user_id = NEW.user_id ORDER BY created_at, id LIMIT 1)
      AND (SELECT count(*) FROM source_attestations WHERE user_id = NEW.user_id AND transaction_id = NEW.transaction_id) = 1
      THEN NEW.time_zone ELSE time_zone END
  WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER transaction_fact_link_insert AFTER INSERT ON transaction_reconciliation_decisions BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER transaction_fact_link_update AFTER UPDATE ON transaction_reconciliation_decisions BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER transaction_fact_link_delete AFTER DELETE ON transaction_reconciliation_decisions BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = OLD.user_id;
END;
CREATE TABLE transaction_fact_assertion (id INTEGER PRIMARY KEY CHECK(id = 1), accepted INTEGER NOT NULL CHECK(accepted = 1)) STRICT;

-- A metadata-only round-robin position prevents unavailable Users from starving other pending work.
CREATE TABLE recurring_dispatch (id INTEGER PRIMARY KEY CHECK(id = 1), last_user TEXT NOT NULL) STRICT;
INSERT INTO recurring_dispatch VALUES (1, '');

-- Progress and staged facts are private detection material, removed after guarded cutover.
CREATE TABLE recurring_progress (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('scan', 'detect', 'complete')),
  cursor_at TEXT NOT NULL DEFAULT '',
  cursor_id TEXT NOT NULL DEFAULT '',
  group_key TEXT NOT NULL DEFAULT '',
  evaluated_at TEXT,
  evaluated_revision INTEGER NOT NULL DEFAULT 0,
  first_captured_at TEXT NOT NULL,
  time_zone TEXT NOT NULL
) STRICT;
CREATE TABLE recurring_facts (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  fact_json TEXT NOT NULL,
  PRIMARY KEY(user_id, id)
) STRICT;
CREATE INDEX recurring_facts_by_group ON recurring_facts(user_id, group_key, occurred_at, id);
CREATE TABLE recurring_proposals (
  user_id TEXT NOT NULL REFERENCES users(id),
  proposal_key TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  PRIMARY KEY(user_id, proposal_key)
) STRICT;
CREATE TABLE recurring_series (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  currency TEXT NOT NULL,
  counterparty_key TEXT NOT NULL,
  series_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0, 1)),
  PRIMARY KEY(user_id, id)
) STRICT;
CREATE INDEX recurring_series_by_order ON recurring_series(user_id, currency, counterparty_key, id);
CREATE TABLE recurring_confirmations (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  context_json TEXT NOT NULL,
  confirmation_json TEXT NOT NULL,
  PRIMARY KEY(user_id, id),
  UNIQUE(user_id, series_id),
  FOREIGN KEY(user_id, series_id) REFERENCES recurring_series(user_id, id)
) STRICT;
CREATE TRIGGER recurring_confirmation_no_update BEFORE UPDATE ON recurring_confirmations BEGIN
  SELECT RAISE(ABORT, 'recurring_confirmation_immutable');
END;
CREATE TABLE recurring_assertion (id INTEGER PRIMARY KEY CHECK(id = 1), accepted INTEGER NOT NULL CHECK(accepted = 1)) STRICT;
CREATE TABLE recurring_cursor_assertion (id INTEGER PRIMARY KEY CHECK(id = 1), expected_revision INTEGER NOT NULL, current_revision INTEGER NOT NULL) STRICT;
CREATE TRIGGER recurring_cursor_current BEFORE INSERT ON recurring_cursor_assertion
WHEN NEW.expected_revision <> NEW.current_revision BEGIN SELECT RAISE(ABORT, 'recurring_cursor_changed'); END;
