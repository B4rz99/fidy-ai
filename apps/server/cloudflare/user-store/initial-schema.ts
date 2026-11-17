/** Initial User-store schema. Schema creation grants no identity, credential or Consent. */
export const initialUserSchema = [
  `CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  locale TEXT NOT NULL CHECK (locale = 'es-CO'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL,
  trial_started_at_ms INTEGER,
  trial_ends_at_ms INTEGER,
  whatsapp_portfolio_id TEXT,
  whatsapp_bsuid TEXT,
  whatsapp_verified_at_ms INTEGER,
  CHECK ((trial_started_at_ms IS NULL AND trial_ends_at_ms IS NULL)
    OR (trial_started_at_ms IS NOT NULL AND trial_ends_at_ms IS NOT NULL
      AND trial_ends_at_ms=trial_started_at_ms+604800000)),
  CHECK ((whatsapp_portfolio_id IS NULL AND whatsapp_bsuid IS NULL AND whatsapp_verified_at_ms IS NULL)
    OR (whatsapp_portfolio_id IS NOT NULL AND whatsapp_bsuid IS NOT NULL AND whatsapp_verified_at_ms IS NOT NULL))
) STRICT`,
  `CREATE UNIQUE INDEX single_user ON users((1))`,
  `CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  pairing_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
  created_at_ms INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL CHECK (fresh_until_ms = created_at_ms + 600000),
  idle_expires_at_ms INTEGER NOT NULL CHECK (idle_expires_at_ms >= created_at_ms AND idle_expires_at_ms <= hard_expires_at_ms),
  hard_expires_at_ms INTEGER NOT NULL CHECK (hard_expires_at_ms = created_at_ms + 7776000000),
  revoked_at_ms INTEGER
) STRICT`,
  `CREATE TABLE consent_history (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), record_type TEXT NOT NULL,
 grant_record_id TEXT, session_id TEXT, occurred_at_ms INTEGER NOT NULL, withdrawal_id TEXT,
 CHECK(record_type IN ('processing_grant','processing_withdrawal','processing_renewal'))
) STRICT`,
  `CREATE TABLE erasure_requests (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), state TEXT NOT NULL
) STRICT`,
  `CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0)
) STRICT`,
  `CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  counterparty TEXT,
  category_id TEXT NOT NULL REFERENCES categories(id),
  notes TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN -62135596800000 AND 253402300799999),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN -62135596800000 AND 253402300799999), revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), user_decisions TEXT NOT NULL DEFAULT '{}', deleted_at_ms INTEGER,
reconciliation_row_ref TEXT,reconciliation_first_id TEXT,reconciliation_second_id TEXT,
 FOREIGN KEY(user_id,reconciliation_first_id,reconciliation_second_id) REFERENCES transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id),
 CHECK((reconciliation_first_id IS NULL AND reconciliation_second_id IS NULL AND reconciliation_row_ref IS NULL) OR (reconciliation_first_id IS NOT NULL AND reconciliation_second_id IS NOT NULL AND id IN(reconciliation_first_id,reconciliation_second_id))),
 CHECK(reconciliation_first_id IS NULL OR deleted_at_ms IS NULL),
  UNIQUE (user_id, id)
) STRICT`,
  `CREATE TABLE transaction_corrections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  changed_fields TEXT NOT NULL,
  before_facts TEXT NOT NULL,
  after_facts TEXT NOT NULL,
  corrected_at_ms INTEGER NOT NULL CHECK(corrected_at_ms BETWEEN -62135596800000 AND 253402300799999),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  UNIQUE (user_id, transaction_id, previous_revision)
) STRICT`,
  `CREATE TABLE transaction_reconciliation_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  first_transaction_id TEXT NOT NULL,
  second_transaction_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('linked', 'keep-separate')),
  visible_transaction_id TEXT,
  decided_at_ms INTEGER NOT NULL CHECK(decided_at_ms BETWEEN -62135596800000 AND 253402300799999),
  PRIMARY KEY (user_id, first_transaction_id, second_transaction_id),
  FOREIGN KEY (user_id, first_transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (user_id, second_transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (user_id, visible_transaction_id) REFERENCES transactions(user_id, id),
  CHECK (first_transaction_id < second_transaction_id),
  CHECK (
    (state = 'linked' AND visible_transaction_id IS NOT NULL
      AND visible_transaction_id IN (first_transaction_id, second_transaction_id))
    OR (state = 'keep-separate' AND visible_transaction_id IS NULL)
  )
) STRICT`,
  `CREATE TABLE source_attestations (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('manual','statement-line','notification-email')),
 service_market TEXT NOT NULL, locale TEXT NOT NULL, time_zone TEXT NOT NULL,
 interpretation_revision TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
 FOREIGN KEY(user_id,transaction_id) REFERENCES transactions(user_id,id)
) STRICT`,
  `CREATE VIEW reconciled_transactions AS SELECT COALESCE(reconciliation_row_ref,'member:'||id) AS rowid,user_id,id AS transaction_id,reconciliation_first_id AS first_transaction_id,reconciliation_second_id AS second_transaction_id FROM transactions WHERE reconciliation_first_id IS NOT NULL`,
  `CREATE VIEW transaction_effective_source AS
WITH linked_decision AS (
  SELECT user_id, first_transaction_id, second_transaction_id, visible_transaction_id
  FROM transaction_reconciliation_decisions WHERE state = 'linked'
), linked_member AS (
  SELECT decision.user_id, decision.first_transaction_id, decision.second_transaction_id,
    retained.id, retained.amount, retained.currency, retained.direction,
    retained.counterparty, retained.category_id, retained.notes,
    retained.occurred_at_ms, retained.created_at_ms, retained.revision,
    (SELECT MAX(correction.corrected_at_ms) FROM transaction_corrections correction
      WHERE correction.user_id = retained.user_id AND correction.transaction_id = retained.id) AS corrected_at_ms,
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
    retained.occurred_at_ms, retained.created_at_ms, retained.revision
  FROM transactions retained
  WHERE retained.deleted_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM reconciled_transactions member
    WHERE member.user_id = retained.user_id AND member.transaction_id = retained.id)
  UNION ALL
  SELECT decision.user_id, decision.visible_transaction_id,
    movement.amount, movement.currency, movement.direction,
    counterparty_member.counterparty, category_member.category_id, notes_member.notes,
    movement.occurred_at_ms, visible.created_at_ms, visible.revision
  FROM linked_decision decision
  JOIN transactions visible ON visible.user_id = decision.user_id
    AND visible.id = decision.visible_transaction_id
  JOIN transactions movement ON movement.user_id = decision.user_id AND movement.id = COALESCE(
    (SELECT member.id FROM linked_member member
      WHERE member.user_id = decision.user_id
        AND member.first_transaction_id = decision.first_transaction_id
        AND member.second_transaction_id = decision.second_transaction_id
        AND member.corrected_at_ms IS NOT NULL
      ORDER BY COALESCE(member.corrected_at_ms, member.created_at_ms) DESC, member.id DESC LIMIT 1),
    (SELECT member.id FROM linked_member member
      WHERE member.user_id = decision.user_id
        AND member.first_transaction_id = decision.first_transaction_id
        AND member.second_transaction_id = decision.second_transaction_id
        AND member.has_statement_source = 1
      ORDER BY COALESCE(member.corrected_at_ms, member.created_at_ms) DESC, member.id DESC LIMIT 1),
    decision.visible_transaction_id)
  JOIN transactions category_member ON category_member.user_id = decision.user_id
    AND category_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.category_decided = 1
        ORDER BY COALESCE(member.corrected_at_ms, member.created_at_ms) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  JOIN transactions counterparty_member ON counterparty_member.user_id = decision.user_id
    AND counterparty_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.counterparty_decided = 1
        ORDER BY COALESCE(member.corrected_at_ms, member.created_at_ms) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  JOIN transactions notes_member ON notes_member.user_id = decision.user_id
    AND notes_member.id = COALESCE(
      (SELECT member.id FROM linked_member member
        WHERE member.user_id = decision.user_id
          AND member.first_transaction_id = decision.first_transaction_id
          AND member.second_transaction_id = decision.second_transaction_id
          AND member.notes_decided = 1
        ORDER BY COALESCE(member.corrected_at_ms, member.created_at_ms) DESC, member.id DESC LIMIT 1),
      decision.visible_transaction_id)
  WHERE EXISTS (SELECT 1 FROM reconciled_transactions first_member
    WHERE first_member.user_id = decision.user_id
      AND first_member.transaction_id = decision.first_transaction_id)
    AND EXISTS (SELECT 1 FROM reconciled_transactions second_member
      WHERE second_member.user_id = decision.user_id
        AND second_member.transaction_id = decision.second_transaction_id)
)
SELECT user_id,id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at,revision FROM effective_transaction`,
  `CREATE TABLE transaction_projection_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version >= 0),
  readiness TEXT NOT NULL CHECK(readiness IN ('ready', 'linking', 'dirty', 'clearing-buckets', 'clearing-digits', 'clearing', 'rebuilding')),
  cursor_id TEXT NOT NULL DEFAULT '',
  attempted_at_ms INTEGER NOT NULL DEFAULT 0
, fact_revision INTEGER CHECK(fact_revision>0), first_captured_at_ms INTEGER CHECK(first_captured_at_ms BETWEEN -62135596800000 AND 253402300799999), time_zone TEXT CHECK(
 (fact_revision IS NULL AND first_captured_at_ms IS NULL AND time_zone IS NULL)
 OR(fact_revision IS NOT NULL AND first_captured_at_ms IS NOT NULL AND time_zone IS NOT NULL)), repair_revision INTEGER NOT NULL DEFAULT 0 CHECK(repair_revision >= 0)) STRICT`,
  `CREATE TABLE transaction_projection_leaf (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow', 'outflow')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  counterparty TEXT,
  notes TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms BETWEEN -62135596800000 AND 253402300799999),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN -62135596800000 AND 253402300799999),
  revision INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT`,
  `CREATE INDEX transaction_projection_leaf_recent ON transaction_projection_leaf
  (user_id, occurred_at_ms DESC, created_at_ms DESC, id DESC)`,
  `CREATE INDEX transaction_projection_leaf_category_recent ON transaction_projection_leaf
  (user_id, category_id, occurred_at_ms DESC, created_at_ms DESC, id DESC)`,
  `CREATE TABLE canonical_request_buckets (
  subject TEXT PRIMARY KEY NOT NULL,
  virtual_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE canonical_request_leases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX canonical_request_lease_expiry ON canonical_request_leases(user_id,expires_at_ms)`,
  `CREATE TABLE commercial_allowance_consumptions (
  user_id TEXT NOT NULL REFERENCES users(id),
  allowance TEXT NOT NULL CHECK (allowance IN ('forwarded_email','media_submission','hosted_history_turn','canonical_call')),
  identity TEXT NOT NULL CHECK (length(identity) BETWEEN 1 AND 128),
  period_start_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  units INTEGER NOT NULL CHECK (units IN (0,1)),
  PRIMARY KEY (user_id, allowance, identity)
)`,
  `CREATE INDEX commercial_allowance_period ON commercial_allowance_consumptions(user_id, allowance, period_start_ms, units)`,
  `CREATE TABLE pro_grant_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  operator TEXT NOT NULL CHECK (length(operator) BETWEEN 1 AND 128),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT`,
  `CREATE TABLE audit_entries (
 record_type TEXT NOT NULL CHECK(record_type='session_call'), id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL REFERENCES web_sessions(id),
 operation TEXT NOT NULL CHECK(operation='transactions.listTransactions'),
 outcome TEXT NOT NULL CHECK(outcome IN ('success','validation_failed')), occurred_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries
 BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`,
  `CREATE TABLE subscriptions (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
 current_paid_attempt_id TEXT,
 FOREIGN KEY(current_paid_attempt_id,id) REFERENCES billing_attempts(id,subscription_id)
) STRICT`,
  `CREATE TABLE payment_sources (
 id TEXT PRIMARY KEY NOT NULL, subscription_id TEXT NOT NULL REFERENCES subscriptions(id)
) STRICT`,
  `CREATE TABLE billing_attempts (
 id TEXT PRIMARY KEY NOT NULL, subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
 payment_source_id TEXT NOT NULL REFERENCES payment_sources(id), paid_starts_at_ms INTEGER,
 paid_ends_at_ms INTEGER, UNIQUE(id,subscription_id),
 CHECK((paid_starts_at_ms IS NULL AND paid_ends_at_ms IS NULL) OR
 (paid_starts_at_ms IS NOT NULL AND paid_ends_at_ms>paid_starts_at_ms))
) STRICT`,
  `CREATE VIEW billing_attempt_context AS
 SELECT a.*,s.user_id FROM billing_attempts a JOIN subscriptions s ON s.id=a.subscription_id`,
  `CREATE VIEW payment_source_context AS
 SELECT p.*,s.user_id FROM payment_sources p JOIN subscriptions s ON s.id=p.subscription_id`,
  `CREATE VIEW subscription_standing AS
 SELECT s.user_id,a.id AS attempt_id FROM subscriptions s JOIN billing_attempts a
 ON a.id=s.current_paid_attempt_id AND a.subscription_id=s.id WHERE a.paid_starts_at_ms IS NOT NULL`,
  `CREATE TABLE refund_attempts (
 id TEXT PRIMARY KEY NOT NULL, billing_attempt_id TEXT NOT NULL REFERENCES billing_attempts(id), access_ends_at_ms INTEGER
) STRICT`,
  `CREATE TABLE subscription_renewal_fences (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id)
) STRICT`,
] as const;
