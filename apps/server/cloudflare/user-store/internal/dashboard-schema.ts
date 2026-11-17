/** Per-User financial contributions and exact base-ten rollups, installed together with their initial facts. */
export const dashboardSchema = [
  `DELETE FROM transaction_projection_leaf`,
  `CREATE TABLE user_documents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('dashboard','recurring-plan')),document_json TEXT NOT NULL CHECK(json_valid(document_json)),revision INTEGER NOT NULL CHECK(revision>=1),PRIMARY KEY(user_id,kind)) STRICT`,
  `CREATE TABLE transaction_projection_bucket (
  user_id TEXT NOT NULL REFERENCES users(id),
  size_seconds INTEGER NOT NULL CHECK(size_seconds IN (60, 86400)),
  bucket INTEGER NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  count INTEGER NOT NULL CHECK(count >= 0),
  max_minor TEXT NOT NULL CHECK(max_minor='0' OR (max_minor GLOB '[1-9]*' AND max_minor NOT GLOB '*[^0-9]*')),
  PRIMARY KEY (user_id, size_seconds, bucket, currency, direction, category_id)
) STRICT`,
  `CREATE TABLE transaction_projection_digit (
  user_id TEXT NOT NULL REFERENCES users(id),
  size_seconds INTEGER NOT NULL CHECK(size_seconds IN (60, 86400)),
  bucket INTEGER NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  digit_sum INTEGER NOT NULL CHECK(digit_sum >= 0),
  PRIMARY KEY (user_id, size_seconds, bucket, currency, direction, category_id, position)
) STRICT`,
  `CREATE TRIGGER transaction_projection_leaf_delete AFTER DELETE ON transaction_projection_leaf
WHEN ((SELECT readiness FROM transaction_projection_state WHERE user_id = OLD.user_id)
  IN ('ready', 'linking', 'rebuilding'))
BEGIN
  UPDATE transaction_projection_bucket SET count = count - 1,
    max_minor = CASE WHEN max_minor != ltrim(CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000' ELSE replace(OLD.amount, '.', '') || substr('0000', 1, 4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END, '0') THEN max_minor ELSE
      COALESCE((SELECT coalesce(nullif(ltrim(CASE WHEN instr(candidate.amount, '.') = 0 THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') || substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.'))) END, '0'),''),'0') FROM transaction_projection_leaf candidate
        INDEXED BY transaction_projection_leaf_category_recent
        WHERE candidate.user_id = OLD.user_id AND candidate.currency = OLD.currency
          AND candidate.direction = OLD.direction AND candidate.category_id = OLD.category_id
          AND candidate.occurred_at_ms >= 1000 * (
            CASE WHEN bucket > 0 THEN bucket * size_seconds
              ELSE (bucket - 1) * size_seconds + 1 END)
          AND candidate.occurred_at_ms < 1000 * (
            CASE WHEN bucket < 0 THEN bucket * size_seconds + 1
              ELSE (bucket + 1) * size_seconds END)
        ORDER BY length(ltrim(CASE WHEN instr(candidate.amount, '.') = 0 THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') || substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.'))) END, '0')) DESC, ltrim(CASE WHEN instr(candidate.amount, '.') = 0 THEN candidate.amount || '0000' ELSE replace(candidate.amount, '.', '') || substr('0000', 1, 4 - (length(candidate.amount) - instr(candidate.amount, '.'))) END, '0') DESC LIMIT 1), '0') END
  WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 60),
      (86400, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 86400))
    AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / size_seconds;
  DELETE FROM transaction_projection_bucket WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 60),
      (86400, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 86400))
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / size_seconds AND count = 0;
  UPDATE transaction_projection_digit SET digit_sum = digit_sum - CAST(substr(
    CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END,
    -position - 1, 1) AS INTEGER)
  WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 60),
      (86400, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 86400))
    AND currency = OLD.currency
    AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / size_seconds
    AND position < length(CASE WHEN instr(OLD.amount, '.') = 0 THEN OLD.amount || '0000'
      ELSE replace(OLD.amount, '.', '') || substr('0000', 1,
        4 - (length(OLD.amount) - instr(OLD.amount, '.'))) END);
  DELETE FROM transaction_projection_digit WHERE user_id = OLD.user_id
    AND (size_seconds, bucket) IN (
      (60, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 60),
      (86400, (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / 86400))
    AND currency = OLD.currency AND direction = OLD.direction AND category_id = OLD.category_id
    AND bucket = (OLD.occurred_at_ms / 1000 - (OLD.occurred_at_ms < 0 AND OLD.occurred_at_ms % 1000 != 0)) / size_seconds
    AND digit_sum = 0;
END`,
  `CREATE TRIGGER transaction_projection_leaf_insert AFTER INSERT ON transaction_projection_leaf
WHEN (SELECT readiness FROM transaction_projection_state WHERE user_id = NEW.user_id)
  IN ('ready', 'linking', 'rebuilding')
BEGIN
  INSERT INTO transaction_projection_bucket
    (user_id, size_seconds, bucket, currency, direction, category_id, count, max_minor)
  SELECT NEW.user_id, segment.size_seconds,
    (NEW.occurred_at_ms / 1000 - (NEW.occurred_at_ms < 0 AND NEW.occurred_at_ms % 1000 != 0)) / segment.size_seconds,
    NEW.currency, NEW.direction, NEW.category_id, 1,
    coalesce(nullif(ltrim(CASE WHEN instr(NEW.amount, '.') = 0 THEN NEW.amount || '0000'
      ELSE replace(NEW.amount, '.', '') || substr('0000', 1,
        4 - (length(NEW.amount) - instr(NEW.amount, '.'))) END, '0'),''),'0')
  FROM (SELECT 60 AS size_seconds UNION ALL SELECT 86400) segment WHERE true
  ON CONFLICT (user_id, size_seconds, bucket, currency, direction, category_id)
  DO UPDATE SET count = count + 1,
    max_minor = (CASE WHEN length(excluded.max_minor) > length(max_minor)
      OR (length(excluded.max_minor) = length(max_minor) AND excluded.max_minor > max_minor)
      THEN excluded.max_minor ELSE max_minor END);
  INSERT INTO transaction_projection_digit
    (user_id, size_seconds, bucket, currency, direction, category_id, position, digit_sum)
  WITH RECURSIVE
    minor(text) AS (SELECT CASE WHEN instr(NEW.amount, '.') = 0 THEN NEW.amount || '0000'
      ELSE replace(NEW.amount, '.', '') || substr('0000', 1,
        4 - (length(NEW.amount) - instr(NEW.amount, '.'))) END),
    digit(position) AS (SELECT 0 UNION ALL SELECT position + 1 FROM digit, minor
      WHERE position + 1 < length(minor.text))
  SELECT NEW.user_id, segment.size_seconds,
    (NEW.occurred_at_ms / 1000 - (NEW.occurred_at_ms < 0 AND NEW.occurred_at_ms % 1000 != 0)) / segment.size_seconds,
    NEW.currency, NEW.direction, NEW.category_id, digit.position,
    CAST(substr(minor.text, -digit.position - 1, 1) AS INTEGER)
  FROM digit CROSS JOIN minor CROSS JOIN
    (SELECT 60 AS size_seconds UNION ALL SELECT 86400) segment WHERE true
  ON CONFLICT (user_id, size_seconds, bucket, currency, direction, category_id, position)
  DO UPDATE SET digit_sum = digit_sum + excluded.digit_sum;
END`,
  `CREATE TRIGGER dashboard_new_user AFTER INSERT ON users BEGIN
  INSERT INTO transaction_projection_state(user_id,version,readiness) VALUES(NEW.id,1,'ready');
END`,
  `CREATE TRIGGER dashboard_capture AFTER INSERT ON transactions
WHEN NEW.deleted_at_ms IS NULL AND (SELECT readiness FROM transaction_projection_state WHERE user_id=NEW.user_id)='ready'
BEGIN
  INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision) VALUES(NEW.user_id,NEW.id,NEW.amount,NEW.currency,NEW.direction,NEW.category_id,NEW.category_revision,NEW.counterparty,NEW.notes,NEW.occurred_at_ms,NEW.created_at_ms,NEW.revision);
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'dashboard_capture') END;
END`,
  `CREATE TRIGGER dashboard_attested_member AFTER INSERT ON source_attestations
WHEN (SELECT readiness FROM transaction_projection_state WHERE user_id=NEW.user_id)='ready'
  AND EXISTS(SELECT 1 FROM transactions WHERE user_id=NEW.user_id AND id=NEW.transaction_id AND reconciliation_first_id IS NOT NULL)
BEGIN
  DELETE FROM transaction_projection_leaf WHERE user_id=NEW.user_id AND id IN (SELECT visible_transaction_id FROM transaction_reconciliation_decisions d JOIN transactions t ON t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.user_id=d.user_id WHERE t.id=NEW.transaction_id AND t.user_id=NEW.user_id AND d.state='linked');
  INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision)
    SELECT user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transaction_effective_source WHERE user_id=NEW.user_id AND id IN (SELECT visible_transaction_id FROM transaction_reconciliation_decisions d JOIN transactions t ON t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.user_id=d.user_id WHERE t.id=NEW.transaction_id AND t.user_id=NEW.user_id AND d.state='linked');
END`,
  `CREATE TABLE transaction_projection_references (
    user_id TEXT NOT NULL REFERENCES users(id),category_revision TEXT NOT NULL,category_id TEXT NOT NULL REFERENCES categories(id),
    count INTEGER NOT NULL CHECK(count>=0),PRIMARY KEY(user_id,category_revision,category_id)
  ) STRICT`,
  `CREATE TRIGGER dashboard_reference_insert AFTER INSERT ON transaction_projection_leaf BEGIN
    INSERT INTO transaction_projection_references(user_id,category_revision,category_id,count)
      VALUES(NEW.user_id,NEW.category_revision,NEW.category_id,1)
      ON CONFLICT(user_id,category_revision,category_id) DO UPDATE SET count=count+1;
  END`,
  `CREATE TRIGGER dashboard_reference_delete AFTER DELETE ON transaction_projection_leaf BEGIN
    UPDATE transaction_projection_references SET count=count-1 WHERE user_id=OLD.user_id AND category_revision=OLD.category_revision AND category_id=OLD.category_id;
    DELETE FROM transaction_projection_references WHERE user_id=OLD.user_id AND category_revision=OLD.category_revision AND category_id=OLD.category_id AND count=0;
  END`,
  `INSERT INTO transaction_projection_state(user_id,version,readiness) SELECT id,1,'ready' FROM users WHERE true
ON CONFLICT(user_id) DO UPDATE SET version=1,readiness='ready',cursor_id=''`,
  `INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision) SELECT user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transaction_effective_source`,
] as const;
