-- The same effective relation is used by History, search, projection maintenance and rebuilds.
-- It is User-filtered at each caller; the view never grants a subject on its own.
CREATE VIEW dashboard_effective_source AS
WITH linked_decision AS (
  SELECT user_id, first_transaction_id, second_transaction_id, visible_transaction_id
  FROM transaction_reconciliation_decisions WHERE state = 'linked'
), linked_member AS (
  SELECT decision.user_id, decision.first_transaction_id, decision.second_transaction_id,
    retained.id, retained.amount, retained.currency, retained.direction,
    retained.counterparty, retained.category_id, retained.notes,
    retained.occurred_at, retained.created_at, retained.revision,
    (SELECT MAX(correction.corrected_at) FROM transaction_corrections correction
      WHERE correction.user_id = retained.user_id AND correction.transaction_id = retained.id) AS corrected_at,
    EXISTS (SELECT 1 FROM source_attestations source
      WHERE source.user_id = retained.user_id AND source.transaction_id = retained.id
        AND source.kind = 'statement-line') AS has_statement_source,
    COALESCE(json_extract(retained.user_decisions, '$.categoryId') = 1, 0) AS category_decided,
    COALESCE(json_extract(retained.user_decisions, '$.counterparty') = 1, 0) AS counterparty_decided,
    COALESCE(json_extract(retained.user_decisions, '$.notes') = 1, 0) AS notes_decided
  FROM linked_decision decision
  JOIN transactions retained ON retained.user_id = decision.user_id
    AND retained.id IN (decision.first_transaction_id, decision.second_transaction_id)
), effective_transaction AS (
  SELECT retained.user_id, retained.id, retained.amount, retained.currency,
    retained.direction, retained.counterparty, retained.category_id, retained.notes,
    retained.occurred_at, retained.created_at, retained.revision
  FROM transactions retained
  WHERE NOT EXISTS (SELECT 1 FROM transaction_reconciliation_members member
    WHERE member.user_id = retained.user_id AND member.transaction_id = retained.id)
  UNION ALL
  SELECT decision.user_id, decision.visible_transaction_id,
    movement.amount, movement.currency, movement.direction,
    counterparty_member.counterparty, category_member.category_id, notes_member.notes,
    movement.occurred_at, visible.created_at, visible.revision
  FROM linked_decision decision
  JOIN transactions visible ON visible.user_id = decision.user_id
    AND visible.id = decision.visible_transaction_id
  JOIN transactions movement ON movement.user_id = decision.user_id AND movement.id = COALESCE(
    (SELECT member.id FROM linked_member member
      WHERE member.user_id = decision.user_id
        AND member.first_transaction_id = decision.first_transaction_id
        AND member.second_transaction_id = decision.second_transaction_id
        AND member.corrected_at IS NOT NULL
      ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1),
    (SELECT member.id FROM linked_member member
      WHERE member.user_id = decision.user_id
        AND member.first_transaction_id = decision.first_transaction_id
        AND member.second_transaction_id = decision.second_transaction_id
        AND member.has_statement_source = 1
      ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1),
    decision.visible_transaction_id)
  JOIN transactions category_member ON category_member.user_id = decision.user_id
    AND category_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.category_decided = 1
        ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  JOIN transactions counterparty_member ON counterparty_member.user_id = decision.user_id
    AND counterparty_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.counterparty_decided = 1
        ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  JOIN transactions notes_member ON notes_member.user_id = decision.user_id
    AND notes_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.notes_decided = 1
        ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  WHERE EXISTS (SELECT 1 FROM transaction_reconciliation_members first_member
    WHERE first_member.user_id = decision.user_id
      AND first_member.transaction_id = decision.first_transaction_id)
    AND EXISTS (SELECT 1 FROM transaction_reconciliation_members second_member
      WHERE second_member.user_id = decision.user_id
        AND second_member.transaction_id = decision.second_transaction_id)
)
SELECT * FROM effective_transaction;

-- Completeness is not inferred from a finite page. All canonical writes dirty this marker
-- before their owner refreshes its effective rows in the same D1 atomic unit.
CREATE TABLE dashboard_projection_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version >= 0),
  readiness TEXT NOT NULL CHECK(readiness IN ('ready', 'linking', 'dirty', 'clearing-buckets', 'clearing-digits', 'clearing', 'rebuilding')),
  cursor_id TEXT NOT NULL DEFAULT '',
  attempted_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX dashboard_projection_due ON dashboard_projection_state(attempted_at_ms, user_id)
  WHERE readiness != 'ready' OR version != 1;
CREATE TABLE dashboard_projection_leaf (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  counterparty TEXT,
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;
CREATE INDEX dashboard_projection_leaf_recent ON dashboard_projection_leaf
  (user_id, occurred_at DESC, created_at DESC, id DESC);
CREATE INDEX dashboard_projection_leaf_category_recent ON dashboard_projection_leaf
  (user_id, category_id, occurred_at DESC, created_at DESC, id DESC);
CREATE VIRTUAL TABLE dashboard_projection_list_search USING fts5(search_text, tokenize='trigram');
-- Padded trigrams index one- and two-character searches without changing their substring semantics.
CREATE TRIGGER dashboard_projection_list_insert AFTER INSERT ON dashboard_projection_leaf
BEGIN
  INSERT INTO dashboard_projection_list_search(rowid, search_text)
  SELECT NEW.rowid, source_text || ' ' || coalesce((
    WITH RECURSIVE offsets(position) AS (
      SELECT 1 UNION ALL SELECT position + 1 FROM offsets
      WHERE position < length(source_text)
    )
    SELECT group_concat('§' || substr(source_text, position, 1) || '§ §'
      || substr(source_text, position, 2), ' ') FROM offsets
  ), '')
  FROM (SELECT coalesce(NEW.counterparty, '') || ' ' || coalesce(NEW.notes, '') AS source_text);
END;
CREATE TRIGGER dashboard_projection_list_delete AFTER DELETE ON dashboard_projection_leaf
BEGIN DELETE FROM dashboard_projection_list_search WHERE rowid = OLD.rowid; END;
CREATE INDEX dashboard_projection_leaf_max ON dashboard_projection_leaf
  (user_id, currency, direction, category_id, length(amount) DESC, amount DESC, occurred_at);
CREATE TABLE dashboard_projection_bucket (
  user_id TEXT NOT NULL REFERENCES users(id),
  size_seconds INTEGER NOT NULL CHECK(size_seconds IN (60, 86400)),
  bucket INTEGER NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  count INTEGER NOT NULL CHECK(count >= 0),
  maximum TEXT NOT NULL,
  max_minor TEXT NOT NULL,
  PRIMARY KEY (user_id, size_seconds, bucket, currency, direction, category_id)
) STRICT;
CREATE TABLE dashboard_projection_digit (
  user_id TEXT NOT NULL REFERENCES users(id),
  size_seconds INTEGER NOT NULL CHECK(size_seconds IN (60, 86400)),
  bucket INTEGER NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  digit_sum INTEGER NOT NULL CHECK(digit_sum >= 0),
  PRIMARY KEY (user_id, size_seconds, bucket, currency, direction, category_id, position)
) STRICT;

-- One accepted amount is expressed in 1/10000 Currency units without floating-point arithmetic.
-- Per-position integer digit counts avoid SQLite's imprecise SUM of arbitrary Money amounts.
CREATE TRIGGER dashboard_projection_leaf_insert AFTER INSERT ON dashboard_projection_leaf
WHEN (SELECT readiness FROM dashboard_projection_state WHERE user_id = NEW.user_id)
  IN ('ready', 'linking', 'rebuilding')
BEGIN
  INSERT INTO dashboard_projection_bucket
    (user_id, size_seconds, bucket, currency, direction, category_id, count, maximum, max_minor)
  SELECT NEW.user_id, segment.size_seconds,
    CAST(strftime('%s', NEW.occurred_at) AS INTEGER) / segment.size_seconds,
    NEW.currency, NEW.direction, NEW.category_id, 1, NEW.amount,
    ltrim(CASE WHEN instr(NEW.amount, '.') = 0 THEN NEW.amount || '0000'
      ELSE replace(NEW.amount, '.', '') || substr('0000', 1,
        4 - (length(NEW.amount) - instr(NEW.amount, '.'))) END, '0')
  FROM (SELECT 60 AS size_seconds UNION ALL SELECT 86400) segment WHERE true
  ON CONFLICT (user_id, size_seconds, bucket, currency, direction, category_id)
  DO UPDATE SET count = count + 1,
    maximum = CASE WHEN length(excluded.max_minor) > length(max_minor)
      OR (length(excluded.max_minor) = length(max_minor) AND excluded.max_minor > max_minor)
      THEN excluded.maximum ELSE maximum END,
    max_minor = (CASE WHEN length(excluded.max_minor) > length(max_minor)
      OR (length(excluded.max_minor) = length(max_minor) AND excluded.max_minor > max_minor)
      THEN excluded.max_minor ELSE max_minor END);
  INSERT INTO dashboard_projection_digit
    (user_id, size_seconds, bucket, currency, direction, category_id, position, digit_sum)
  WITH RECURSIVE
    minor(text) AS (SELECT CASE WHEN instr(NEW.amount, '.') = 0 THEN NEW.amount || '0000'
      ELSE replace(NEW.amount, '.', '') || substr('0000', 1,
        4 - (length(NEW.amount) - instr(NEW.amount, '.'))) END),
    digit(position) AS (SELECT 0 UNION ALL SELECT position + 1 FROM digit, minor
      WHERE position + 1 < length(minor.text))
  SELECT NEW.user_id, segment.size_seconds,
    CAST(strftime('%s', NEW.occurred_at) AS INTEGER) / segment.size_seconds,
    NEW.currency, NEW.direction, NEW.category_id, digit.position,
    CAST(substr(minor.text, -digit.position - 1, 1) AS INTEGER)
  FROM digit CROSS JOIN minor CROSS JOIN
    (SELECT 60 AS size_seconds UNION ALL SELECT 86400) segment WHERE true
  ON CONFLICT (user_id, size_seconds, bucket, currency, direction, category_id, position)
  DO UPDATE SET digit_sum = digit_sum + excluded.digit_sum;
END;

CREATE TRIGGER dashboard_projection_leaf_delete AFTER DELETE ON dashboard_projection_leaf
WHEN (SELECT readiness FROM dashboard_projection_state WHERE user_id = OLD.user_id)
  IN ('ready', 'linking', 'rebuilding')
BEGIN
  UPDATE dashboard_projection_bucket SET count = count - 1,
    maximum = CASE WHEN maximum != OLD.amount THEN maximum ELSE
      COALESCE((SELECT candidate.amount FROM dashboard_projection_leaf candidate
        WHERE candidate.user_id = OLD.user_id AND candidate.currency = OLD.currency
          AND candidate.direction = OLD.direction AND candidate.category_id = OLD.category_id
          AND CAST(strftime('%s', candidate.occurred_at) AS INTEGER) / size_seconds = bucket
        ORDER BY length(ltrim(CASE WHEN instr(candidate.amount, '.') = 0
          THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') ||
          substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.')))
          END, '0')) DESC,
          ltrim(CASE WHEN instr(candidate.amount, '.') = 0
          THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') ||
          substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.')))
          END, '0') DESC LIMIT 1), '0') END
  WHERE user_id = OLD.user_id AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds;
  UPDATE dashboard_projection_bucket SET max_minor = ltrim(
    CASE WHEN instr(maximum, '.') = 0 THEN maximum || '0000'
      ELSE replace(maximum, '.', '') || substr('0000', 1,
        4 - (length(maximum) - instr(maximum, '.'))) END, '0')
  WHERE user_id = OLD.user_id AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds;
  DELETE FROM dashboard_projection_bucket WHERE user_id = OLD.user_id
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds AND count = 0;
  UPDATE dashboard_projection_digit SET digit_sum = digit_sum - CAST(substr(
    CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END,
    -position - 1, 1) AS INTEGER)
  WHERE user_id = OLD.user_id AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds
    AND position < length(CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END);
  DELETE FROM dashboard_projection_digit WHERE user_id = OLD.user_id
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds
    AND digit_sum = 0;
END;

CREATE TRIGGER dashboard_projection_new_user AFTER INSERT ON users
BEGIN INSERT INTO dashboard_projection_state (user_id, version, readiness)
  VALUES (NEW.id, 1, 'ready'); END;
CREATE TRIGGER dashboard_projection_decision_insert AFTER INSERT ON transaction_reconciliation_decisions
BEGIN UPDATE dashboard_projection_state SET readiness = 'linking'
  WHERE user_id = NEW.user_id AND readiness = 'ready'; END;
CREATE TRIGGER dashboard_projection_decision_update AFTER UPDATE ON transaction_reconciliation_decisions
BEGIN UPDATE dashboard_projection_state SET readiness = 'linking'
  WHERE user_id = NEW.user_id AND readiness = 'ready'; END;

-- One guarded migration backfill completes before a pre-existing User is marked ready.
INSERT INTO dashboard_projection_state (user_id, version, readiness)
SELECT id, 1, 'rebuilding' FROM users;
INSERT INTO dashboard_projection_leaf
  (user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision)
SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
  occurred_at, created_at, revision FROM dashboard_effective_source;
UPDATE dashboard_projection_state SET readiness = 'ready' WHERE readiness = 'rebuilding';

-- SQLite cannot share a parameterized refresh subroutine between triggers. Keep the mirrored
-- leaf column lists in capture, update, Correction, SourceAttestation, link, unlink, and repair
-- in sync. Focused Dashboard tests exercise capture, correction, and reconciliation refreshes;
-- owner tests exercise the attestation and ingestion write paths.
-- Each trigger replaces the old contribution with the current effective relation's contribution.
-- These triggers run inside the caller's D1 batch: audit refusal and batch rollback undo both.
CREATE TRIGGER dashboard_projection_capture AFTER INSERT ON transactions
BEGIN
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id AND id = NEW.id;
END;
CREATE TRIGGER dashboard_projection_corrected_transaction AFTER UPDATE ON transactions
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.id, (SELECT decision.visible_transaction_id
      FROM transaction_reconciliation_members member
      JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = member.user_id
        AND decision.first_transaction_id = member.first_transaction_id
        AND decision.second_transaction_id = member.second_transaction_id
      WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.id));
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.id, (SELECT decision.visible_transaction_id
        FROM transaction_reconciliation_members member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.id));
END;
CREATE TRIGGER dashboard_projection_deleted_transaction AFTER DELETE ON transactions
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id AND id = OLD.id;
END;
CREATE TRIGGER dashboard_projection_corrected_source AFTER INSERT ON transaction_corrections
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
      FROM transaction_reconciliation_members member
      JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = member.user_id
        AND decision.first_transaction_id = member.first_transaction_id
        AND decision.second_transaction_id = member.second_transaction_id
      WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
        FROM transaction_reconciliation_members member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
END;
CREATE TRIGGER dashboard_projection_attested_source AFTER INSERT ON source_attestations
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
      FROM transaction_reconciliation_members member
      JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = member.user_id
        AND decision.first_transaction_id = member.first_transaction_id
        AND decision.second_transaction_id = member.second_transaction_id
      WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
        FROM transaction_reconciliation_members member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
END;
CREATE TRIGGER dashboard_projection_link_member AFTER INSERT ON transaction_reconciliation_members
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.first_transaction_id, NEW.second_transaction_id);
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.first_transaction_id, NEW.second_transaction_id);
  UPDATE dashboard_projection_state SET readiness = 'ready'
    WHERE user_id = NEW.user_id AND readiness = 'linking'
    AND (SELECT COUNT(*) FROM transaction_reconciliation_members
      WHERE user_id = NEW.user_id AND first_transaction_id = NEW.first_transaction_id
        AND second_transaction_id = NEW.second_transaction_id) = 2;
END;
CREATE TRIGGER dashboard_projection_unlink_member AFTER DELETE ON transaction_reconciliation_members
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id
    AND id IN (OLD.first_transaction_id, OLD.second_transaction_id);
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = OLD.user_id
      AND id IN (OLD.first_transaction_id, OLD.second_transaction_id);
  UPDATE dashboard_projection_state SET readiness = 'ready'
    WHERE user_id = OLD.user_id AND readiness = 'linking'
    AND NOT EXISTS (SELECT 1 FROM transaction_reconciliation_members
      WHERE user_id = OLD.user_id AND first_transaction_id = OLD.first_transaction_id
        AND second_transaction_id = OLD.second_transaction_id);
END;
