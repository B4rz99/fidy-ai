import { Clock, Effect, Exit, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../src/core/identity/contract";
import {
  UserRegistrationUnavailable,
  maintenanceName,
  registerLifetimeUrl,
  registrationAcceptedStatus,
} from "../maintenance/contract";
import type { StoreHistory } from "../runtime/sqlite/contract";

/** Initial User-store schema. Schema creation grants no identity, credential or Consent. */
const initialUserSchema = [
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

/** User schema v2. Existing references were written under the one Colombian launch revision. */
const categoryTaxonomyMigration = [
  `ALTER TABLE transactions ADD COLUMN category_revision TEXT NOT NULL DEFAULT 'co-1'`,
  `ALTER TABLE transaction_projection_leaf ADD COLUMN category_revision TEXT NOT NULL DEFAULT 'co-1'`,
  `DROP VIEW transaction_effective_source`,
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
    retained.occurred_at_ms, retained.created_at_ms, retained.revision, retained.category_revision
  FROM transactions retained
  WHERE retained.deleted_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM reconciled_transactions member
    WHERE member.user_id = retained.user_id AND member.transaction_id = retained.id)
  UNION ALL
  SELECT decision.user_id, decision.visible_transaction_id,
    movement.amount, movement.currency, movement.direction,
    counterparty_member.counterparty, category_member.category_id, notes_member.notes,
    movement.occurred_at_ms, visible.created_at_ms, visible.revision, category_member.category_revision
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
SELECT user_id,id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at,revision,category_revision FROM effective_transaction`,
  `ALTER TABLE transaction_corrections ADD COLUMN before_category_revision TEXT NOT NULL DEFAULT 'co-1'`,
  `ALTER TABLE transaction_corrections ADD COLUMN after_category_revision TEXT NOT NULL DEFAULT 'co-1'`,
  `CREATE TABLE keyword_rules (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    keyword TEXT NOT NULL CHECK(length(keyword) BETWEEN 1 AND 80 AND keyword=trim(keyword)),
    category_id TEXT NOT NULL REFERENCES categories(id),
    category_revision TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(user_id,keyword)
  ) STRICT`,
  `CREATE TRIGGER keyword_rule_capacity BEFORE INSERT ON keyword_rules
     WHEN (SELECT count(*) FROM keyword_rules WHERE user_id=NEW.user_id)>=100
     BEGIN SELECT RAISE(ABORT,'keyword_rule_capacity'); END`,
  `CREATE TABLE budgets (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    category_id TEXT NOT NULL REFERENCES categories(id),
    category_revision TEXT NOT NULL,
    currency TEXT NOT NULL,cap TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,
    group_name TEXT,starts_month TEXT,
    UNIQUE(user_id,category_id,currency),UNIQUE(user_id,id)
  ) STRICT`,
] as const;

/** Immutable User-store step extending the existing Subscription standing tables for cancellation. */
const sourceCancellationSchema = [
  "ALTER TABLE payment_sources ADD COLUMN method TEXT CHECK(method IN ('card','nequi','daviplata'))",
  "ALTER TABLE payment_sources ADD COLUMN wompi_source_id INTEGER CHECK(wompi_source_id>0)",
  "ALTER TABLE payment_sources ADD COLUMN wompi_environment TEXT CHECK(wompi_environment IN ('sandbox','production'))",
  "ALTER TABLE billing_attempts ADD COLUMN wompi_environment TEXT CHECK(wompi_environment IN ('sandbox','production'))",
  `CREATE TABLE subscription_cancellations (
    paid_attempt_id TEXT PRIMARY KEY REFERENCES billing_attempts(id), subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
    payment_source_id TEXT NOT NULL REFERENCES payment_sources(id), cancelled_at_ms INTEGER NOT NULL,
    paid_through_ms INTEGER NOT NULL, source_cancellation_state TEXT NOT NULL CHECK(source_cancellation_state IN ('void-pending','voided','detached')),
    void_started_at_ms INTEGER, void_verified_at_ms INTEGER, verification_count INTEGER NOT NULL DEFAULT 0 CHECK(verification_count BETWEEN 0 AND 8),
    next_offer_at_ms INTEGER, next_verification_at_ms INTEGER,
    CHECK(source_cancellation_state='void-pending' OR next_offer_at_ms IS NULL)
  ) STRICT`,
  "CREATE INDEX subscription_cancellation_due ON subscription_cancellations(next_offer_at_ms,paid_attempt_id) WHERE next_offer_at_ms IS NOT NULL",
] as const;

const canonicalCaptureMigration = [
  `CREATE TABLE pats (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  short_id TEXT NOT NULL UNIQUE CHECK (length(short_id) = 8),
  bearer_digest BLOB NOT NULL CHECK (length(bearer_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  last_used_at_ms INTEGER,
  revoked_at_ms INTEGER,
  pairing_id TEXT UNIQUE,
  request_id TEXT UNIQUE,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL)),
  CHECK (expires_at_ms <= created_at_ms + lifetime_days * 86400000)
) STRICT`,
  `ALTER TABLE audit_entries RENAME TO previous_audit_entries`,
  `CREATE TABLE audit_entries (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), record_type TEXT NOT NULL,
    session_id TEXT REFERENCES web_sessions(id), pat_id TEXT REFERENCES pats(id),
    operation TEXT NOT NULL,outcome TEXT,occurred_at_ms INTEGER NOT NULL,
    CHECK ((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND outcome IS NOT NULL
      AND outcome IN ('success','validation_failed','not_found')) OR
      (record_type='credential_call' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NOT NULL AND outcome IN ('accepted','rejected')) OR
      (record_type='request_admission' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NULL))
  ) STRICT`,
  `INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT record_type,id,user_id,session_id,operation,outcome,occurred_at_ms FROM previous_audit_entries`,
  `DROP TABLE previous_audit_entries`,
  `CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries
      BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation='transactions.createTransaction' AND json_valid(body)))
  ) STRICT`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
] as const;

/** Broaden the safe result allowlist without changing the schema history or any original retry window. */
const cancellationReceiptMigration = [
  `CREATE TRIGGER retained_source_identity BEFORE UPDATE OF id,subscription_id,method,wompi_source_id,wompi_environment ON payment_sources
    WHEN EXISTS (SELECT 1 FROM subscription_cancellations WHERE payment_source_id=OLD.id)
    AND (NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.method IS NOT OLD.method
      OR NEW.wompi_source_id IS NOT OLD.wompi_source_id OR NEW.wompi_environment IS NOT OLD.wompi_environment)
    BEGIN SELECT RAISE(ABORT,'retained_source_identity'); END`,
  "ALTER TABLE canonical_request_receipts RENAME TO receipts_before_cancellation",
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT,PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('transactions.createTransaction','subscription.cancelSubscription') AND json_valid(body)))
  ) STRICT`,
  `INSERT INTO canonical_request_receipts(user_id,retry_key_digest,operation,input_digest,accepted_at_ms,status,body)
    SELECT user_id,retry_key_digest,operation,input_digest,accepted_at_ms,status,body FROM receipts_before_cancellation`,
  "DROP TABLE receipts_before_cancellation",
  "CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)",
] as const;

const correctionMigration = [
  `ALTER TABLE canonical_request_receipts RENAME TO previous_capture_receipts`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions') AND json_valid(body)))
  ) STRICT`,
  `INSERT INTO canonical_request_receipts SELECT * FROM previous_capture_receipts`,
  `DROP TABLE previous_capture_receipts`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
  `CREATE TRIGGER transaction_correction_no_update BEFORE UPDATE ON transaction_corrections BEGIN SELECT RAISE(ABORT,'correction_append_only'); END`,
  `CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations BEGIN SELECT RAISE(ABORT,'attestation_immutable'); END`,
  `CREATE TRIGGER transaction_user_decisions BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at_ms IS NOT OLD.occurred_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND EXISTS (
  SELECT 1 FROM json_each(OLD.user_decisions)
  WHERE value = 1 AND json_extract(NEW.user_decisions, '$.' || key) IS NOT 1
) OR (
  NEW.revision != OLD.revision AND
  (NEW.revision != OLD.revision + 1 OR NOT EXISTS (
    SELECT 1 FROM transaction_corrections
    WHERE user_id = OLD.user_id AND transaction_id = OLD.id AND previous_revision = OLD.revision
  ))
) OR (
  NOT (NEW.revision = OLD.revision + 1 AND EXISTS (
    SELECT 1 FROM transaction_corrections
    WHERE user_id = OLD.user_id AND transaction_id = OLD.id AND previous_revision = OLD.revision
  )) AND (
  (json_extract(OLD.user_decisions, '$.money') = 1 AND (NEW.amount != OLD.amount OR NEW.currency != OLD.currency)) OR
  (json_extract(OLD.user_decisions, '$.direction') = 1 AND NEW.direction != OLD.direction) OR
  (json_extract(OLD.user_decisions, '$.occurredAt') = 1 AND NEW.occurred_at_ms != OLD.occurred_at_ms) OR
  (json_extract(OLD.user_decisions, '$.categoryId') = 1 AND NEW.category_id != OLD.category_id) OR
  (json_extract(OLD.user_decisions, '$.counterparty') = 1 AND NEW.counterparty IS NOT OLD.counterparty) OR
  (json_extract(OLD.user_decisions, '$.notes') = 1 AND NEW.notes IS NOT OLD.notes)
))
BEGIN SELECT RAISE(ABORT, 'transaction_user_decision'); END`,
] as const;

export const userStoreHistory: StoreHistory = {
  owner: "user",
  steps: [
    { version: 1, id: "initial-user-schema", statements: initialUserSchema },
    { version: 2, id: "category-taxonomy", statements: categoryTaxonomyMigration },
    { version: 3, id: "subscription-cancellation", statements: sourceCancellationSchema },
    { version: 4, id: "canonical-capture", statements: canonicalCaptureMigration },
    { version: 5, id: "cancellation-receipt", statements: cancellationReceiptMigration },
    { version: 6, id: "canonical-corrections", statements: correctionMigration },
    {
      version: 7,
      id: "lifetime-registration-acknowledgement",
      statements: [
        "ALTER TABLE users ADD COLUMN lifetime_registered INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_registered IN (0,1))",
      ],
    },
  ],
};

/** Complete each bounded family independently; a failed check remains distinguishable from an empty page. */
export const recoverUserWork = <E, R>(
  families: ReadonlyArray<Effect.Effect<Readonly<{ attempted: number; failed: number }>, E, R>>
): Effect.Effect<
  Readonly<{ failedFamilies: number; attempted: number; failedOffers: number }>,
  never,
  R
> =>
  Effect.forEach(families, (family) => family.pipe(Effect.timeout("45 seconds"), Effect.exit), {
    concurrency: 4,
  }).pipe(
    Effect.map((results) => {
      let failedFamilies = 0,
        attempted = 0,
        failedOffers = 0;
      for (const result of results) {
        if (Exit.isFailure(result)) failedFamilies++;
        else {
          attempted += result.value.attempted;
          failedOffers += result.value.failed;
        }
      }
      return { failedFamilies, attempted, failedOffers };
    })
  );

/** Register outside the User transaction, before committing activation or accepting work. */
export const registerUserLifetime = Effect.fn(function* (
  maintenance: Pick<DurableObjectNamespace, "getByName">,
  userId: UserId
) {
  const issuedAt = yield* Clock.currentTimeMillis;
  const response = yield* Effect.tryPromise((signal) =>
    maintenance.getByName(maintenanceName).fetch(registerLifetimeUrl, {
      method: "POST",
      headers: { "fidy-user-id": userId, "fidy-registration-issued-ms": String(issuedAt) },
      signal,
    })
  );
  if (response.status !== registrationAcceptedStatus) {
    return yield* new UserRegistrationUnavailable();
  }
});

/** An empty store has no work. Its reserved bootstrap registers independently before creating the User. */
export const observeUserRegistration = Effect.fn(function* (
  maintenance: Pick<DurableObjectNamespace, "getByName">,
  owns: (id: string) => boolean
) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT id,lifetime_registered FROM users LIMIT 1`;
  if (row === undefined) return false;
  const user = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      id: UserId,
      lifetime_registered: Schema.Literals([0, 1]),
    })
  )(row);
  if (!owns(user.id)) return false;
  if (user.lifetime_registered === 1) return true;
  yield* registerUserLifetime(maintenance, user.id);
  const confirmed = yield* sql`UPDATE users SET lifetime_registered=1 WHERE id=${user.id}
    AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${user.id}) RETURNING id`;
  return confirmed.length === 1;
});
