-- Preserve the authoritative effective-fact policy while forcing the existing UNIQUE(user_id, id)
-- access path for each pair member. Without statistics SQLite can choose a lifetime-User scan
-- for the two-id IN join on every Reconciliation pair. This constraint index is declared in 0009.
DROP VIEW dashboard_effective_source;
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
  JOIN transactions retained INDEXED BY sqlite_autoindex_transactions_2
    ON retained.user_id = decision.user_id
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

-- Address the two affected primary-key prefixes instead of scanning every retained bucket/digit.
-- Maximum replacement uses an indexed occurrence range. Bounds preserve SQLite's integer division
-- toward zero for pre-epoch instants too; exact decimal comparison and digit arithmetic are unchanged.
DROP TRIGGER dashboard_projection_leaf_delete;
CREATE TRIGGER dashboard_projection_leaf_delete AFTER DELETE ON dashboard_projection_leaf
WHEN (SELECT readiness FROM dashboard_projection_state WHERE user_id = OLD.user_id)
  IN ('ready', 'linking', 'rebuilding')
BEGIN
  UPDATE dashboard_projection_bucket SET count = count - 1,
    maximum = CASE WHEN maximum != OLD.amount THEN maximum ELSE
      COALESCE((SELECT candidate.amount FROM dashboard_projection_leaf candidate
        INDEXED BY dashboard_projection_leaf_category_recent
        WHERE candidate.user_id = OLD.user_id AND candidate.currency = OLD.currency
          AND candidate.direction = OLD.direction AND candidate.category_id = OLD.category_id
          AND candidate.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ',
            CASE WHEN bucket > 0 THEN bucket * size_seconds
              ELSE (bucket - 1) * size_seconds + 1 END, 'unixepoch')
          AND candidate.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ',
            CASE WHEN bucket < 0 THEN bucket * size_seconds + 1
              ELSE (bucket + 1) * size_seconds END, 'unixepoch')
        ORDER BY length(ltrim(CASE WHEN instr(candidate.amount, '.') = 0
          THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') ||
          substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.')))
          END, '0')) DESC,
          ltrim(CASE WHEN instr(candidate.amount, '.') = 0
          THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') ||
          substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.')))
          END, '0') DESC LIMIT 1), '0') END
  WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 60),
      (86400, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 86400))
    AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds;
  UPDATE dashboard_projection_bucket SET max_minor = ltrim(
    CASE WHEN instr(maximum, '.') = 0 THEN maximum || '0000'
      ELSE replace(maximum, '.', '') || substr('0000', 1,
        4 - (length(maximum) - instr(maximum, '.'))) END, '0')
  WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 60),
      (86400, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 86400))
    AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds;
  DELETE FROM dashboard_projection_bucket WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 60),
      (86400, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 86400))
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds AND count = 0;
  UPDATE dashboard_projection_digit SET digit_sum = digit_sum - CAST(substr(
    CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END,
    -position - 1, 1) AS INTEGER)
  WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 60),
      (86400, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 86400))
    AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds
    AND position < length(CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END);
  DELETE FROM dashboard_projection_digit WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 60),
      (86400, CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / 86400))
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = CAST(strftime('%s', OLD.occurred_at) AS INTEGER) / size_seconds
    AND digit_sum = 0;
END;
