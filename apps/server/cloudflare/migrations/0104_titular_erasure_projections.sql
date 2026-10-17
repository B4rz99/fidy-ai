DROP TRIGGER budget_removed_version;
CREATE TRIGGER budget_removed_version AFTER DELETE ON budgets
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='budgets' AND (OLD.user_id=q.user_id))
BEGIN INSERT INTO budget_user_versions (user_id, revision) VALUES (OLD.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
  DELETE FROM budget_reconciliation_work WHERE user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM budgets WHERE user_id = OLD.user_id); END;

DROP TRIGGER dashboard_projection_deleted_transaction;
CREATE TRIGGER dashboard_projection_deleted_transaction AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id AND id = OLD.id;
END;

DROP TRIGGER dashboard_projection_unlink_member;
CREATE TRIGGER dashboard_projection_unlink_member AFTER DELETE ON transaction_reconciliation_members
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transaction_reconciliation_members' AND (OLD.user_id=q.user_id))
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

DROP TRIGGER transaction_fact_delete;
CREATE TRIGGER transaction_fact_delete AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = OLD.user_id;
END;

DROP TRIGGER transaction_fact_link_delete;
CREATE TRIGGER transaction_fact_link_delete AFTER DELETE ON transaction_reconciliation_decisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transaction_reconciliation_decisions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE transaction_fact_state SET revision = revision + 1 WHERE user_id = OLD.user_id;
END;

DROP TRIGGER hosted_retention_transcript_remove;
CREATE TRIGGER hosted_retention_transcript_remove AFTER DELETE ON transcript_entries
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transcript_entries' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;

DROP TRIGGER hosted_retention_mutation_remove;
CREATE TRIGGER hosted_retention_mutation_remove AFTER DELETE ON hosted_mutation_commits
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_mutation_commits' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;

DROP TRIGGER hosted_retention_channel_remove;
CREATE TRIGGER hosted_retention_channel_remove AFTER DELETE ON hosted_whatsapp_inbound
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_whatsapp_inbound WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_whatsapp_inbound' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM hosted_turn_retention WHERE turn_id = OLD.turn_id AND user_id = OLD.user_id;
END;

DROP TRIGGER dashboard_projection_leaf_delete;
CREATE TRIGGER dashboard_projection_leaf_delete AFTER DELETE ON dashboard_projection_leaf
WHEN ((SELECT readiness FROM dashboard_projection_state WHERE user_id = OLD.user_id)
  IN ('ready', 'linking', 'rebuilding'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='dashboard_projection_leaf' AND (OLD.user_id=q.user_id))
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
