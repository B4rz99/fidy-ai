import { acceptanceProviderRevision } from "../release-isolation/contract";
import { auditRetentionSchema } from "../audit/contract";
import { acceptanceSubject } from "../release-isolation/operations";
import type { NativeAcceptanceSettings } from "../release-isolation/contract";
import { sampleSchema } from "./internal/sample-schema";
import { hostedSchema } from "./internal/hosted-schema";
import { ingestionSchema } from "./internal/ingestion-schema";
import { billingAdmissionSchema } from "./internal/billing-admission-schema";
import { connectionGrantCleanupSchema, connectionSchema } from "./internal/connection-schema";
import {
  connectionAuditSchema,
  hostedMetadataAuditSchema,
  mediaAuditSchema,
  oauthUserSchema,
  userPATSchema,
} from "./internal/credential-schema";
import { externalEventSchema, issueForwardingAddress } from "./internal/external-event-schema";
import { registerUserLifetime as registerReservedLifetime } from "./internal/registration";
import { Effect, Exit, Predicate, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../src/core/identity/contract";

import type { StoreHistory } from "../runtime/sqlite/contract";

const sourceTable = `CREATE TABLE source_attestations (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('manual','statement-line','notification-email')),
 service_market TEXT NOT NULL, locale TEXT NOT NULL, time_zone TEXT NOT NULL,
 interpretation_revision TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
 FOREIGN KEY(user_id,transaction_id) REFERENCES transactions(user_id,id)
) STRICT`;

const attestationImmutable = `CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations BEGIN SELECT RAISE(ABORT,'attestation_immutable'); END`;

const dashboardAttestedMember = `CREATE TRIGGER dashboard_attested_member AFTER INSERT ON source_attestations
WHEN (SELECT readiness FROM transaction_projection_state WHERE user_id=NEW.user_id)='ready'
  AND EXISTS(SELECT 1 FROM transactions WHERE user_id=NEW.user_id AND id=NEW.transaction_id AND reconciliation_first_id IS NOT NULL)
BEGIN
  DELETE FROM transaction_projection_leaf WHERE user_id=NEW.user_id AND id IN (SELECT visible_transaction_id FROM transaction_reconciliation_decisions d JOIN transactions t ON t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.user_id=d.user_id WHERE t.id=NEW.transaction_id AND t.user_id=NEW.user_id AND d.state='linked');
  INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision)
    SELECT user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transaction_effective_source WHERE user_id=NEW.user_id AND id IN (SELECT visible_transaction_id FROM transaction_reconciliation_decisions d JOIN transactions t ON t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.user_id=d.user_id WHERE t.id=NEW.transaction_id AND t.user_id=NEW.user_id AND d.state='linked');
END`;

const transactionFactAttestation = `CREATE TRIGGER transaction_fact_attestation AFTER INSERT ON source_attestations BEGIN
  UPDATE transaction_projection_state SET fact_revision = fact_revision + 1,
    time_zone = CASE WHEN NEW.transaction_id = (SELECT id FROM transactions WHERE user_id = NEW.user_id ORDER BY created_at_ms, id LIMIT 1)
      AND (SELECT count(*) FROM source_attestations WHERE user_id = NEW.user_id AND transaction_id = NEW.transaction_id) = 1
      THEN NEW.time_zone ELSE time_zone END
  WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END`;

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
  sourceTable,
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
  attestationImmutable,
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

const budgetPlanningMigration = [
  `ALTER TABLE canonical_request_receipts RENAME TO receipts_before_budgets`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions','budgets.createBudget','budgets.updateBudget','budgets.deleteBudget') AND json_valid(body)))
  ) STRICT`,
  `INSERT INTO canonical_request_receipts SELECT * FROM receipts_before_budgets`,
  `DROP TABLE receipts_before_budgets`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
  `CREATE TABLE budget_month_plan_records (
 kind TEXT NOT NULL CHECK(kind IN ('cap','plan','currency')),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 month TEXT NOT NULL,
 budget_id TEXT,
 group_name TEXT,
 cap TEXT,
 currency TEXT,
 FOREIGN KEY(user_id,budget_id) REFERENCES budgets(user_id,id) ON DELETE CASCADE,
 CHECK((kind='cap' AND budget_id IS NOT NULL AND cap IS NOT NULL AND group_name IS NULL AND currency IS NULL)
 OR(kind='plan' AND budget_id IS NULL AND cap IS NULL AND group_name IS NULL AND currency IS NULL)
 OR(kind='currency' AND budget_id IS NULL AND cap IS NULL AND group_name IS NOT NULL AND currency IS NOT NULL))
) STRICT`,
  `CREATE UNIQUE INDEX budget_month_cap_identity ON budget_month_plan_records(user_id,budget_id,month) WHERE kind='cap'`,
  `CREATE UNIQUE INDEX budget_month_currency_identity ON budget_month_plan_records(user_id,group_name,month) WHERE kind='currency'`,
  `CREATE UNIQUE INDEX budget_month_plan_identity ON budget_month_plan_records(user_id,month) WHERE kind='plan'`,
  `CREATE INDEX budgets_by_user ON budgets(user_id, currency, category_id)`,
  `CREATE TRIGGER budget_capacity BEFORE INSERT ON budgets
WHEN (SELECT COUNT(*) FROM budgets WHERE user_id = NEW.user_id) >= 128
BEGIN SELECT RAISE(ABORT, 'budget_capacity_limit'); END`,
] as const;

const dashboardSchema = [
  `ALTER TABLE canonical_request_receipts RENAME TO receipts_before_dashboard`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions','budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','dashboard.initializeDashboard','dashboard.applyDashboardEdit') AND json_valid(body)))
  ) STRICT`,
  `INSERT INTO canonical_request_receipts SELECT * FROM receipts_before_dashboard`,
  `DROP TABLE receipts_before_dashboard`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
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
  SELECT CASE WHEN changes()<>2 THEN RAISE(ABORT,'dashboard_bucket_removed') END;
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
  SELECT CASE WHEN changes()<>2 THEN RAISE(ABORT,'dashboard_bucket_missing') END;
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
  SELECT CASE WHEN changes()<>2*length(CASE WHEN instr(NEW.amount,'.')=0 THEN NEW.amount||'0000'
    ELSE replace(NEW.amount,'.','')||substr('0000',1,4-(length(NEW.amount)-instr(NEW.amount,'.'))) END)
    THEN RAISE(ABORT,'dashboard_digits_missing') END;
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
  dashboardAttestedMember,
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

const recurringSchema = [
  `ALTER TABLE canonical_request_receipts RENAME TO receipts_before_recurring`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions','budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','dashboard.initializeDashboard','dashboard.applyDashboardEdit','recurringPlans.applyRecurringEdit','transactions.deleteTransaction') AND json_valid(body)))
  ) STRICT`,
  `INSERT INTO canonical_request_receipts SELECT * FROM receipts_before_recurring`,
  `DROP TABLE receipts_before_recurring`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
  `CREATE TRIGGER deleted_transaction_no_link BEFORE UPDATE OF reconciliation_first_id,reconciliation_second_id ON transactions WHEN NEW.reconciliation_first_id IS NOT NULL AND NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'transaction_deleted'); END`,
  `CREATE TRIGGER deleted_transaction_no_update BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at_ms IS NOT OLD.occurred_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND OLD.deleted_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'transaction_deleted'); END`,
  `CREATE TABLE recurring_receipt_parts(user_id TEXT NOT NULL,retry_key_digest TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),part TEXT NOT NULL,PRIMARY KEY(user_id,retry_key_digest,position), FOREIGN KEY(user_id,retry_key_digest) REFERENCES canonical_request_receipts(user_id,retry_key_digest) ON DELETE CASCADE) STRICT`,
  `CREATE TRIGGER recurring_receipt_parts_parent BEFORE INSERT ON recurring_receipt_parts
    WHEN NOT EXISTS(SELECT 1 FROM canonical_request_receipts WHERE user_id=NEW.user_id AND retry_key_digest=NEW.retry_key_digest AND operation='recurringPlans.applyRecurringEdit' AND json_type(body)='integer')
    BEGIN SELECT RAISE(ABORT,'invalid_recurring_receipt'); END`,
  `CREATE TABLE "recurring_evaluation_records" (
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('fact','proposal','progress')),
 id TEXT NOT NULL,
 group_key TEXT,
 occurred_at_ms INTEGER,
 fact_json TEXT,
 proposal_json TEXT,
 revision INTEGER,
 phase TEXT CHECK(phase IN ('scan','detect','complete')),
 cursor_at_ms INTEGER,
 cursor_id TEXT,
 evaluated_at_ms INTEGER,
 evaluated_revision INTEGER,
 first_captured_at_ms INTEGER,
 time_zone TEXT,
 CHECK((kind='fact' AND group_key IS NOT NULL AND occurred_at_ms IS NOT NULL AND fact_json IS NOT NULL AND proposal_json IS NULL)
 OR(kind='proposal' AND group_key IS NULL AND occurred_at_ms IS NULL AND fact_json IS NULL AND proposal_json IS NOT NULL)
 OR(kind='progress' AND id='progress' AND group_key IS NOT NULL AND occurred_at_ms IS NULL AND fact_json IS NULL AND proposal_json IS NULL)),
 CHECK((kind='progress' AND revision IS NOT NULL AND phase IS NOT NULL AND cursor_id IS NOT NULL AND ((cursor_at_ms IS NULL AND cursor_id='') OR (cursor_at_ms IS NOT NULL AND cursor_id IS NOT NULL AND cursor_id<>'')) AND evaluated_revision IS NOT NULL AND first_captured_at_ms IS NOT NULL AND time_zone IS NOT NULL)
 OR(kind<>'progress' AND revision IS NULL AND phase IS NULL AND cursor_at_ms IS NULL AND cursor_id IS NULL AND evaluated_at_ms IS NULL AND evaluated_revision IS NULL AND first_captured_at_ms IS NULL AND time_zone IS NULL)),
 PRIMARY KEY(user_id,kind,id)
) STRICT`,
  `CREATE INDEX recurring_facts_by_group_typed ON recurring_evaluation_records(user_id, group_key, occurred_at_ms, id) WHERE kind='fact'`,
  transactionFactAttestation,
  `CREATE TRIGGER transaction_fact_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO transaction_projection_state(user_id,version,readiness,fact_revision,first_captured_at_ms,time_zone)
  SELECT NEW.user_id,0,'dirty',1,NEW.created_at_ms,time_zone FROM users WHERE id=NEW.user_id
  ON CONFLICT(user_id) DO UPDATE SET fact_revision=coalesce(fact_revision,0)+1,
    first_captured_at_ms=coalesce(first_captured_at_ms,excluded.first_captured_at_ms),
    time_zone=coalesce(transaction_projection_state.time_zone,excluded.time_zone);
END`,
  `UPDATE transaction_projection_state AS state SET fact_revision=1,
 first_captured_at_ms=(SELECT min(created_at_ms) FROM transactions WHERE user_id=state.user_id),
 time_zone=coalesce((SELECT source.time_zone FROM transactions movement LEFT JOIN source_attestations source ON source.transaction_id=movement.id AND source.user_id=movement.user_id WHERE movement.user_id=state.user_id ORDER BY movement.created_at_ms,movement.id,source.created_at_ms,source.id LIMIT 1),(SELECT time_zone FROM users WHERE id=state.user_id))
 WHERE fact_revision IS NULL AND EXISTS (SELECT 1 FROM transactions WHERE user_id=state.user_id)`,
  `CREATE TABLE recurring_series (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  currency TEXT NOT NULL,
  counterparty_key TEXT NOT NULL,
  series_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0, 1)), confirmation_id TEXT, confirmed_at_ms INTEGER, confirmation_context_json TEXT, confirmation_json TEXT, digest_excluded INTEGER CHECK(digest_excluded IN(0,1)), confirmation_sequence INTEGER CHECK(
 (confirmation_id IS NULL AND confirmed_at_ms IS NULL AND confirmation_context_json IS NULL
  AND confirmation_json IS NULL AND digest_excluded IS NULL AND confirmation_sequence IS NULL)
 OR (confirmation_id IS NOT NULL AND confirmed_at_ms IS NOT NULL AND confirmation_context_json IS NOT NULL
  AND confirmation_json IS NOT NULL AND digest_excluded IS NOT NULL AND confirmation_sequence IS NOT NULL
  AND confirmation_sequence>0)),
  PRIMARY KEY(user_id, id)
) STRICT`,
  `CREATE TABLE recurring_plans (user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), pauses_json TEXT NOT NULL CHECK(json_valid(pauses_json)), stopped_on TEXT, PRIMARY KEY(user_id,id)) STRICT`,
  `CREATE TABLE recurring_plan_revisions (user_id TEXT NOT NULL, plan_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), from_date TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), PRIMARY KEY(user_id,plan_id,from_date), FOREIGN KEY(user_id,plan_id) REFERENCES recurring_plans(user_id,id)) STRICT`,
  `CREATE TABLE recurring_plan_exceptions (user_id TEXT NOT NULL, plan_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), local_date TEXT NOT NULL, skipped INTEGER NOT NULL CHECK(skipped IN(0,1)), replacement_json TEXT CHECK(replacement_json IS NULL OR json_valid(replacement_json)), PRIMARY KEY(user_id,plan_id,local_date), FOREIGN KEY(user_id,plan_id) REFERENCES recurring_plans(user_id,id)) STRICT`,
  `CREATE TABLE recurring_plan_fulfillments (user_id TEXT NOT NULL, id TEXT NOT NULL, plan_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), local_date TEXT NOT NULL, actual_date TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL, settled INTEGER NOT NULL CHECK(settled IN(0,1)), automatic INTEGER CHECK(automatic IS NULL OR automatic IN(0,1)), transaction_id TEXT, PRIMARY KEY(user_id,id), FOREIGN KEY(user_id,plan_id) REFERENCES recurring_plans(user_id,id)) STRICT`,
  `CREATE INDEX recurring_plans_ordered ON recurring_plans(user_id,position)`,
  `CREATE INDEX recurring_plan_revisions_ordered ON recurring_plan_revisions(user_id,position)`,
  `CREATE INDEX recurring_plan_exceptions_ordered ON recurring_plan_exceptions(user_id,position)`,
  `CREATE INDEX recurring_plan_fulfillments_ordered ON recurring_plan_fulfillments(user_id,position)`,
  `CREATE INDEX recurring_series_by_order ON recurring_series(user_id, currency, counterparty_key, id)`,
] as const;

const atomicBatchReceipts = [
  `DROP TRIGGER recurring_receipt_parts_parent`,
  `ALTER TABLE recurring_receipt_parts RENAME TO receipt_parts_before_batch`,
  `ALTER TABLE canonical_request_receipts RENAME TO receipts_before_batch`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions','budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','dashboard.initializeDashboard','dashboard.applyDashboardEdit','recurringPlans.applyRecurringEdit','transactions.deleteTransaction','operations.executeAtomicBatch','categories.createKeywordRule','categories.updateKeywordRule','categories.deleteKeywordRule','transactions.updateTransactions') AND json_valid(body)))
  ) STRICT`,
  `CREATE TABLE canonical_receipt_parts(user_id TEXT NOT NULL,retry_key_digest TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),part TEXT NOT NULL,PRIMARY KEY(user_id,retry_key_digest,position), FOREIGN KEY(user_id,retry_key_digest) REFERENCES canonical_request_receipts(user_id,retry_key_digest) ON DELETE CASCADE) STRICT`,
  `CREATE TRIGGER canonical_receipt_parts_parent BEFORE INSERT ON canonical_receipt_parts
    WHEN NOT EXISTS(SELECT 1 FROM canonical_request_receipts WHERE user_id=NEW.user_id AND retry_key_digest=NEW.retry_key_digest AND operation IN ('recurringPlans.applyRecurringEdit','operations.executeAtomicBatch') AND json_type(body)='integer')
    BEGIN SELECT RAISE(ABORT,'invalid_recurring_receipt'); END`,
  `INSERT INTO canonical_request_receipts SELECT * FROM receipts_before_batch`,
  `INSERT INTO canonical_receipt_parts SELECT * FROM receipt_parts_before_batch`,
  `DROP TABLE receipt_parts_before_batch`,
  `DROP TABLE receipts_before_batch`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
] as const;

const connectionReceipts = [
  `DROP TRIGGER canonical_receipt_parts_parent`,
  `ALTER TABLE canonical_receipt_parts RENAME TO receipt_parts_before_batch`,
  `ALTER TABLE canonical_request_receipts RENAME TO receipts_before_batch`,
  `CREATE TABLE canonical_request_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),retry_key_digest TEXT NOT NULL CHECK(length(retry_key_digest)=64),
    operation TEXT NOT NULL,input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    accepted_at_ms INTEGER NOT NULL,status INTEGER NOT NULL CHECK(status BETWEEN 200 AND 499),
    body TEXT, PRIMARY KEY(user_id,retry_key_digest),
    CHECK(body IS NULL OR (operation IN ('subscription.cancelSubscription','transactions.createTransaction','transactions.updateTransaction','transactions.linkTransactions','transactions.unlinkTransactions','budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','dashboard.initializeDashboard','dashboard.applyDashboardEdit','recurringPlans.applyRecurringEdit','transactions.deleteTransaction','operations.executeAtomicBatch','categories.createKeywordRule','categories.updateKeywordRule','categories.deleteKeywordRule','transactions.updateTransactions','connections.connectInstitution') AND json_valid(body)))
  ) STRICT`,
  `CREATE TABLE canonical_receipt_parts(user_id TEXT NOT NULL,retry_key_digest TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),part TEXT NOT NULL,PRIMARY KEY(user_id,retry_key_digest,position), FOREIGN KEY(user_id,retry_key_digest) REFERENCES canonical_request_receipts(user_id,retry_key_digest) ON DELETE CASCADE) STRICT`,
  `CREATE TRIGGER canonical_receipt_parts_parent BEFORE INSERT ON canonical_receipt_parts
    WHEN NOT EXISTS(SELECT 1 FROM canonical_request_receipts WHERE user_id=NEW.user_id AND retry_key_digest=NEW.retry_key_digest AND operation IN ('recurringPlans.applyRecurringEdit','operations.executeAtomicBatch') AND json_type(body)='integer')
    BEGIN SELECT RAISE(ABORT,'invalid_recurring_receipt'); END`,
  `INSERT INTO canonical_request_receipts SELECT * FROM receipts_before_batch`,
  `INSERT INTO canonical_receipt_parts SELECT * FROM receipt_parts_before_batch`,
  `DROP TABLE receipt_parts_before_batch`,
  `DROP TABLE receipts_before_batch`,
  `CREATE INDEX canonical_receipt_expiry ON canonical_request_receipts(accepted_at_ms)`,
] as const;

const refundSchema: ReadonlyArray<string> = [
  `ALTER TABLE refund_attempts ADD COLUMN intent_json TEXT CHECK(intent_json IS NULL OR json_valid(intent_json))`,
  `ALTER TABLE refund_attempts ADD COLUMN user_id TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.userId')) VIRTUAL REFERENCES users(id)`,
  `ALTER TABLE refund_attempts ADD COLUMN request_id TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.requestId')) VIRTUAL`,
  `ALTER TABLE refund_attempts ADD COLUMN kind TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.intent.kind')) VIRTUAL`,
  `ALTER TABLE refund_attempts ADD COLUMN treatment_json TEXT CHECK(treatment_json IS NULL OR json_valid(treatment_json))`,
  `ALTER TABLE refund_attempts ADD COLUMN transaction_id TEXT REFERENCES billing_provider_transactions(transaction_id)`,
  `ALTER TABLE refund_attempts ADD COLUMN wompi_environment TEXT CHECK(wompi_environment='sandbox')`,
  `ALTER TABLE refund_attempts ADD COLUMN amount_in_cents INTEGER CHECK(amount_in_cents BETWEEN 1 AND 9007199254740991)`,
  `ALTER TABLE refund_attempts ADD COLUMN operator_id TEXT CHECK(length(operator_id) BETWEEN 1 AND 128)`,
  `ALTER TABLE refund_attempts ADD COLUMN created_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed'))`,
  `ALTER TABLE refund_attempts ADD COLUMN progress TEXT NOT NULL DEFAULT 'queued' CHECK(progress IN ('queued','verifying','outcome-unknown'))`,
  `ALTER TABLE refund_attempts ADD COLUMN finalized_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN failure TEXT CHECK(failure IN ('provider-declined','provider-cancelled','provider-refused'))`,
  `ALTER TABLE refund_attempts ADD COLUMN dispatch_last_attempt_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK(verification_attempts BETWEEN 0 AND 8)`,
  `ALTER TABLE refund_attempts ADD COLUMN last_verification_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN submission_claimed_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN provider_refund_id TEXT`,
  `ALTER TABLE refund_attempts ADD COLUMN verified_status TEXT CHECK(verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED'))`,
  `ALTER TABLE refund_attempts ADD COLUMN observed_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN renewal_stopped_at_ms INTEGER`,
  `CREATE UNIQUE INDEX refund_request ON refund_attempts(user_id,request_id)`,
  `CREATE UNIQUE INDEX refund_provider_identity ON refund_attempts(wompi_environment,provider_refund_id)`,
  `CREATE INDEX refund_offer_due ON refund_attempts(status,progress,dispatch_last_attempt_at_ms) WHERE intent_json IS NOT NULL`,
  `CREATE VIEW refund_charge_context AS
SELECT a.*,CAST(substr(a.amount,1,instr(a.amount||'.','.')-1) AS INTEGER)*100
  +CAST(substr(substr(a.amount,instr(a.amount||'.','.')+1)||'00',1,2) AS INTEGER) AS original_cents
FROM billing_attempt_context a
WHERE original_cents BETWEEN 1 AND 9007199254740991
  AND a.currency='COP' AND length(a.amount) BETWEEN 1 AND 17
  AND a.amount NOT GLOB '*[^0-9.]*'
  AND length(a.amount)-length(replace(a.amount,'.',''))<=1
  AND length(substr(a.amount,1,instr(a.amount||'.','.')-1)) BETWEEN 1 AND 14
  AND (instr(a.amount,'.')=0 OR length(a.amount)-instr(a.amount,'.') BETWEEN 1 AND 2)
  AND (length(substr(a.amount,1,instr(a.amount||'.','.')-1))=1 OR substr(a.amount,1,1)<>'0')`,
  `CREATE VIEW refund_attempt_context AS
SELECT r.rowid,r.*,a.subscription_id,a.price_id,a.currency,a.original_cents,
 CASE WHEN r.access_ends_at_ms IS NOT NULL THEN r.billing_attempt_id END AS adjusted_attempt_id,
 CASE WHEN r.renewal_stopped_at_ms IS NOT NULL THEN r.user_id END AS renewal_stopped_user_id
FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id`,
  `CREATE TRIGGER refund_acceptance_limit BEFORE INSERT ON refund_attempts
WHEN (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id AND status='pending')>=4
 OR (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id
   AND created_at_ms>NEW.created_at_ms-3600000)>=12
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_claim_immutable BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NOT NULL AND (NEW.submission_claimed_at_ms IS NOT OLD.submission_claimed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_claim_immutable');
END`,
  `CREATE TRIGGER refund_claim_requires_pending BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NULL AND NEW.submission_claimed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r
  JOIN billing_attempt_context a ON a.id=r.billing_attempt_id
  JOIN billing_provider_transactions e ON e.transaction_id=r.transaction_id AND e.attempt_id=a.id
  WHERE r.id=NEW.id AND r.status='pending' AND a.status='succeeded'
    AND a.wompi_environment='sandbox' AND e.status='APPROVED'
    AND (SELECT COUNT(*) FROM billing_provider_transactions AS billing_transaction_evidence
      WHERE attempt_id=a.id AND status='APPROVED')=1))
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.intent_json IS NOT NULL AND (NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.access_ends_at_ms IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL) BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END`,
  `CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NOT NULL AND (NEW.provider_refund_id IS NOT OLD.provider_refund_id OR NEW.verified_status IS NOT OLD.verified_status OR NEW.observed_at_ms IS NOT OLD.observed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_immutable');
END`,
  `CREATE TRIGGER refund_evidence_requires_claim BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r JOIN (SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL) c ON c.refund_id=r.id
  WHERE r.id=NEW.id AND r.status='pending' AND NEW.observed_at_ms>=r.created_at_ms
    AND ((r.kind='refund' AND NEW.verified_status IN ('APPROVED','DECLINED','CANCELLED'))
      OR (r.kind='card-void' AND NEW.verified_status='VOIDED'))))
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_invalid_claim');
END`,
  `CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NEW.intent_json IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempt_context a
  JOIN billing_provider_transactions e ON e.attempt_id=a.id
  JOIN payment_source_context p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND a.wompi_environment=NEW.wompi_environment
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM billing_provider_transactions AS billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > (SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id) - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR NOT EXISTS (SELECT 1 FROM refund_charge_context a WHERE a.id=NEW.billing_attempt_id)
  OR (NEW.kind='card-void' AND NEW.amount_in_cents<>(SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id)) )
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id OR NEW.wompi_environment<>OLD.wompi_environment
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.treatment_json<>OLD.treatment_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents
 OR NEW.kind<>OLD.kind OR NEW.operator_id<>OLD.operator_id OR NEW.created_at_ms<>OLD.created_at_ms
 OR (OLD.status<>'pending' AND (NEW.status<>OLD.status OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms
   OR NEW.failure IS NOT OLD.failure OR NEW.progress<>OLD.progress))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END`,
  `CREATE TRIGGER refund_verified_settlement AFTER UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL
BEGIN
 UPDATE refund_attempts SET status=CASE WHEN NEW.verified_status IN ('APPROVED','VOIDED')
    THEN 'succeeded' ELSE 'failed' END, finalized_at_ms=NEW.observed_at_ms,
    failure=CASE NEW.verified_status WHEN 'DECLINED' THEN 'provider-declined'
      WHEN 'CANCELLED' THEN 'provider-cancelled' ELSE NULL END
    WHERE id=NEW.id AND status='pending';
 UPDATE refund_attempts SET access_ends_at_ms=incoming.ends_at_ms FROM (SELECT id AS refund_id,billing_attempt_id AS attempt_id,NEW.observed_at_ms AS ends_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.access_ends_at_ms IS NULL;
 UPDATE refund_attempts SET renewal_stopped_at_ms=incoming.stopped_at_ms FROM (SELECT id AS refund_id,user_id AS user_id,NEW.observed_at_ms AS stopped_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.renewal_stopped_at_ms IS NULL;
 INSERT OR IGNORE INTO subscription_renewal_fences(user_id) SELECT user_id FROM refund_attempts WHERE id=NEW.id AND status='succeeded';
 UPDATE billing_attempts SET followup_due_at_ms=NULL WHERE id=NEW.billing_attempt_id AND EXISTS(SELECT 1 FROM refund_attempts WHERE id=NEW.id AND status='succeeded');
END`,
];

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
    { version: 8, id: "monthly-budget-planning", statements: budgetPlanningMigration },
    { version: 9, id: "native-dashboard", statements: dashboardSchema },
    {
      version: 10,
      id: "browser-bootstrap-and-proof-outcomes",
      statements: [
        `CREATE TABLE provider_credentials(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),contact_email TEXT,established_at_ms INTEGER NOT NULL,PRIMARY KEY(issuer,subject)) STRICT`,
        `CREATE TABLE backup_recovery_credentials(user_id TEXT PRIMARY KEY REFERENCES users(id),code_digest BLOB NOT NULL UNIQUE CHECK(length(code_digest)=32),created_at_ms INTEGER NOT NULL,consumed_at_ms INTEGER,revision INTEGER NOT NULL) STRICT`,
        `ALTER TABLE consent_history ADD COLUMN disclosure_json TEXT`,
        `ALTER TABLE consent_history ADD COLUMN disclosure_message_id TEXT`,
        `ALTER TABLE consent_history ADD COLUMN decision_message_id TEXT`,
        `ALTER TABLE consent_history ADD COLUMN decision_received_at_ms INTEGER`,
        "ALTER TABLE audit_entries RENAME TO pre_bootstrap_audit",
        `CREATE TABLE audit_entries(id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),record_type TEXT NOT NULL,session_id TEXT REFERENCES web_sessions(id),pat_id TEXT REFERENCES pats(id),
        operation TEXT,outcome TEXT,occurred_at_ms INTEGER NOT NULL,CHECK((record_type='identity_read' AND session_id IS NOT NULL AND pat_id IS NULL AND operation IS NULL AND outcome IS NULL) OR
        (operation IS NOT NULL AND ((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND outcome IS NOT NULL AND outcome IN ('success','validation_failed','not_found')) OR
        (record_type='credential_call' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NOT NULL AND outcome IN ('accepted','rejected')) OR
        (record_type='request_admission' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NULL))))) STRICT`,
        "INSERT INTO audit_entries SELECT * FROM pre_bootstrap_audit",
        "DROP TABLE pre_bootstrap_audit",
        "CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_immutable'); END",
        `CREATE TABLE browser_handoffs(id TEXT PRIMARY KEY,pairing_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,ordinal INTEGER NOT NULL UNIQUE,
        verifier_digest TEXT NOT NULL,expires_at_ms INTEGER NOT NULL,wrong_attempts INTEGER NOT NULL,last_poll_ms INTEGER,minimum_poll_seconds INTEGER NOT NULL,
        evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),recovery_generation INTEGER NOT NULL DEFAULT 0,claim_id TEXT,claim_at_ms INTEGER,outcome TEXT NOT NULL CHECK(outcome IN ('pending','committed','cancelled')),state TEXT NOT NULL CHECK(state IN ('pending_approval','invalidated','ready','consumed'))) STRICT`,
        "CREATE INDEX ready_browser_pairings ON browser_handoffs(ordinal) WHERE state='ready'",
      ],
    },
    { version: 11, id: "native-recurring", statements: recurringSchema },
    { version: 12, id: "atomic-batch-receipts", statements: atomicBatchReceipts },
    { version: 13, id: "external-callback-owners", statements: externalEventSchema() },
    {
      version: 14,
      id: "identity-security-operations",
      statements: [
        "CREATE TABLE recovery_rotations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),prior_digest TEXT NOT NULL,next_digest TEXT NOT NULL,revision INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','committed','cancelled'))) STRICT",
        "ALTER TABLE users ADD COLUMN whatsapp_revision INTEGER NOT NULL DEFAULT 1",
        "CREATE TABLE verified_email_credentials(user_id TEXT PRIMARY KEY REFERENCES users(id),normalized_address TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,verified_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE email_replacements(user_id TEXT PRIMARY KEY REFERENCES users(id),work_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES web_sessions(id),prior_key TEXT NOT NULL,revision INTEGER NOT NULL,candidate TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('awaiting_delivery','sending','awaiting_proof','rejected','ambiguous','proven')),public_code TEXT,proof_digest BLOB,wrong_attempts INTEGER NOT NULL DEFAULT 0) STRICT",
        "CREATE TABLE email_replacement_limits(user_id TEXT PRIMARY KEY REFERENCES users(id),reset_at_ms INTEGER NOT NULL,used INTEGER NOT NULL) STRICT",
        "CREATE TABLE identity_change_outcomes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,context_digest BLOB NOT NULL,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('committed','cancelled'))) STRICT",
        "CREATE INDEX local_identity_change_deadline ON identity_change_outcomes(expires_at_ms)",
        "CREATE TABLE support_recovery_cases(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),pairing_id TEXT NOT NULL UNIQUE,operator_issuer TEXT NOT NULL,operator_subject TEXT NOT NULL,credential_revision INTEGER NOT NULL,opened_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state='approved'),closed_at_ms INTEGER NOT NULL) STRICT",
        "CREATE INDEX recovery_rotation_expiry ON recovery_rotations(state,expires_at_ms)",
        "ALTER TABLE audit_entries RENAME TO pre_rotation_audit",
        `CREATE TABLE audit_entries(id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),record_type TEXT NOT NULL,session_id TEXT REFERENCES web_sessions(id),pat_id TEXT REFERENCES pats(id),
        operation TEXT,outcome TEXT,occurred_at_ms INTEGER NOT NULL,CHECK((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND ((operation='emailAuthentication.requestEmailReplacement' AND outcome='accepted') OR (operation='emailAuthentication.completeEmailReplacement' AND outcome IN ('replaced','rejected')))) OR (record_type='security_mutation' AND session_id IS NOT NULL AND pat_id IS NULL AND operation='recovery.rotateBackupRecoveryCode' AND outcome IS NULL) OR (record_type='identity_read' AND session_id IS NOT NULL AND pat_id IS NULL AND operation IS NULL AND outcome IS NULL) OR
        (operation IS NOT NULL AND ((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND outcome IS NOT NULL AND outcome IN ('success','validation_failed','not_found')) OR
        (record_type='credential_call' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NOT NULL AND outcome IN ('accepted','rejected')) OR
        (record_type='request_admission' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NULL))))) STRICT`,
        "INSERT INTO audit_entries SELECT * FROM pre_rotation_audit",
        "DROP TABLE pre_rotation_audit",
        "CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_immutable'); END",
      ],
    },
    {
      version: 15,
      id: "native-cli-credentials",
      statements: [...userPATSchema(), issueForwardingAddress(), ...oauthUserSchema()],
    },
    {
      version: 16,
      id: "login-email-admission",
      statements: [
        "ALTER TABLE browser_handoffs ADD COLUMN email_login INTEGER NOT NULL DEFAULT 0",
        "CREATE INDEX login_email_handoff_expiry ON browser_handoffs(expires_at_ms) WHERE email_login=1",
        "CREATE TABLE login_email_window(singleton INTEGER PRIMARY KEY CHECK(singleton=1),reset_at_ms INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 5)) STRICT",
        "CREATE TABLE login_email_proofs(pairing_id TEXT PRIMARY KEY REFERENCES browser_handoffs(pairing_id) ON DELETE CASCADE,work_id TEXT NOT NULL UNIQUE,address TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,requested_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,offer_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('awaiting_delivery','sending','awaiting_proof','rejected','ambiguous','approved')),selector TEXT,digest BLOB,wrong_attempts INTEGER NOT NULL DEFAULT 0) STRICT",
        "CREATE INDEX login_email_offer ON login_email_proofs(offer_at_ms) WHERE state='awaiting_delivery'",
        "CREATE INDEX login_email_expiry ON login_email_proofs(expires_at_ms)",
      ],
    },
    { version: 17, id: "retained-ingestion", statements: ingestionSchema() },
    { version: 18, id: "immutable-billing-admissions", statements: billingAdmissionSchema() },
    { version: 19, id: "human-sample-review", statements: sampleSchema() },
    {
      version: 20,
      id: "user-connections",
      statements: [
        ...connectionSchema(),
        ...connectionReceipts,
        "CREATE TABLE saved_attestations AS SELECT * FROM source_attestations",
        "DROP TABLE source_attestations",
        sourceTable.replace("'notification-email'", "'notification-email','connection-movement'"),
        ...ingestionSchema().filter((statement) =>
          statement.startsWith("ALTER TABLE source_attestations ADD COLUMN")
        ),
        "INSERT INTO source_attestations SELECT * FROM saved_attestations",
        "DROP TABLE saved_attestations",
        attestationImmutable,
        dashboardAttestedMember,
        transactionFactAttestation,
        ...connectionAuditSchema(),
      ],
    },
    { version: 21, id: "hosted-agent-work", statements: hostedSchema() },
    {
      version: 22,
      id: "erasure-admission-handoff",
      statements: [
        "ALTER TABLE erasure_requests ADD COLUMN requested_at_ms INTEGER",
        "ALTER TABLE erasure_requests ADD COLUMN session_id TEXT",
        "ALTER TABLE erasure_requests ADD COLUMN handoff_due_ms INTEGER",
      ],
    },
    {
      version: 23,
      id: "hosted-batch-child-audit",
      statements: [
        `CREATE TABLE hosted_batch_child_audit(turn_id TEXT NOT NULL REFERENCES hosted_turns(id) ON DELETE CASCADE, tool_call_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 11), operation TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success','not_found','validation_failed','resource_limit')), occurred_ms INTEGER NOT NULL,PRIMARY KEY(turn_id,tool_call_id,position)) STRICT`,
        `CREATE TRIGGER hosted_batch_child_audit_immutable BEFORE UPDATE ON hosted_batch_child_audit BEGIN SELECT RAISE(ABORT,'audit_immutable'); END`,
      ],
    },
    {
      version: 24,
      id: "original-write-drain",
      statements: [
        "ALTER TABLE erasure_requests ADD COLUMN sample_cursor TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE erasure_requests ADD COLUMN observed_custody TEXT CHECK(observed_custody IS NULL OR json_valid(observed_custody))",
        "CREATE TABLE erasure_expired_mail(work_id TEXT PRIMARY KEY, requested_at_ms INTEGER NOT NULL) STRICT",
        "CREATE VIEW erasure_mail_scope AS SELECT work_id,requested_at_ms FROM erasure_expired_mail UNION ALL SELECT work_id,requested_at_ms FROM login_email_proofs WHERE selector IS NOT NULL UNION ALL SELECT work_id,created_at_ms FROM email_replacements WHERE public_code IS NOT NULL",
        "CREATE TRIGGER preserve_login_mail_scope BEFORE DELETE ON login_email_proofs WHEN OLD.selector IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests) BEGIN INSERT OR IGNORE INTO erasure_expired_mail VALUES(OLD.work_id,OLD.requested_at_ms); END",
        "CREATE TRIGGER preserve_replacement_mail_scope BEFORE DELETE ON email_replacements WHEN OLD.public_code IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests) BEGIN INSERT OR IGNORE INTO erasure_expired_mail VALUES(OLD.work_id,OLD.created_at_ms); END",
        "ALTER TABLE payment_enrollments ADD COLUMN source_creation TEXT CHECK(source_creation IN('issued','settled'))",
        "UPDATE payment_enrollments SET source_creation='issued' WHERE state IN('creating','verifying')",
        `CREATE VIEW local_erasure_custody AS SELECT
         EXISTS(SELECT 1 FROM whatsapp_deliveries WHERE started_ms IS NOT NULL) OR EXISTS(SELECT 1 FROM hosted_whatsapp_inbound) OR EXISTS(SELECT 1 FROM users WHERE whatsapp_bsuid IS NOT NULL) AS whatsapp,
         EXISTS(SELECT 1 FROM login_email_proofs WHERE selector IS NOT NULL) OR EXISTS(SELECT 1 FROM email_replacements WHERE public_code IS NOT NULL) AS resend,
         EXISTS(SELECT 1 FROM billing_attempts WHERE collection_sent_at_ms IS NOT NULL) OR EXISTS(SELECT 1 FROM payment_enrollments WHERE source_creation IS NOT NULL OR state IN ('creating','verifying','available')) OR EXISTS(SELECT 1 FROM payment_sources) AS wompi`,
        "CREATE TABLE original_writers(nonce TEXT PRIMARY KEY,bucket TEXT NOT NULL CHECK(bucket IN('statement','email')),object_key TEXT NOT NULL,checked_ms INTEGER NOT NULL DEFAULT 0) STRICT",
        "CREATE INDEX original_writer_check ON original_writers(checked_ms,nonce)",
      ],
    },
    {
      version: 25,
      id: "operational-uncertainty-observation",
      statements: [
        "CREATE INDEX uncertain_login_email ON login_email_proofs(requested_at_ms) WHERE state IN ('sending','ambiguous')",
        "CREATE INDEX uncertain_replacement_email ON email_replacements(created_at_ms) WHERE state IN ('sending','ambiguous')",
        "CREATE INDEX uncertain_billing_send ON billing_attempts(collection_sent_at_ms) WHERE collection_state='sent' AND status='pending'",
        "CREATE INDEX uncertain_whatsapp_send ON whatsapp_deliveries(started_ms) WHERE state IN ('sending','accepted','ambiguous')",
      ],
    },
    {
      version: 26,
      id: "hosted-credential-and-digest-evidence",
      statements: [
        ...hostedMetadataAuditSchema(),
        `CREATE TABLE recurring_digest_reports(event_id TEXT PRIMARY KEY REFERENCES insight_events(id) ON DELETE CASCADE,
         report_json TEXT NOT NULL CHECK(json_valid(report_json) AND json_extract(report_json,'$.insightEventId')=event_id)) STRICT`,
        "CREATE TRIGGER recurring_digest_immutable BEFORE UPDATE ON recurring_digest_reports BEGIN SELECT RAISE(ABORT,'digest_immutable'); END",
      ],
    },
    { version: 27, id: "native-billing-refunds", statements: refundSchema },
    {
      version: 28,
      id: "signed-whatsapp-media-and-voice",
      statements: [
        ...mediaAuditSchema(),
        `CREATE TABLE media_capacity_receipts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),portfolio TEXT NOT NULL,message TEXT NOT NULL,input_digest TEXT NOT NULL,accepted_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,due_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('storing','discarding','retained')),capacity_slot INTEGER,capacity_generation INTEGER,capacity_claimed INTEGER NOT NULL DEFAULT 0 CHECK(capacity_claimed IN(0,1)),UNIQUE(user_id,portfolio,message)) STRICT`,
        "CREATE INDEX media_receipt_due ON media_capacity_receipts(due_ms)",
        `CREATE TABLE whatsapp_voice_refusals(portfolio TEXT NOT NULL,message TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),claimed_ms INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('started','accepted','failed')),PRIMARY KEY(portfolio,message)) STRICT`,
        "CREATE INDEX voice_refusal_expiry ON whatsapp_voice_refusals(user_id,claimed_ms)",
      ],
    },
    {
      version: 29,
      id: "retained-consent-evidence",
      statements: [
        "CREATE TRIGGER consent_history_no_delete BEFORE DELETE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_history_retention_required'); END",
      ],
    },
    { version: 30, id: "user-audit-retention", statements: auditRetentionSchema },
    {
      version: 31,
      id: "category-disclosure-purpose",
      statements: [
        "ALTER TABLE reminder_disclosures ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual-entry-reminder' CHECK(kind IN ('manual-entry-reminder','budget-threshold','new-recurring-series','weekly-summary'))",
        "CREATE INDEX native_disclosure_purpose ON reminder_disclosures(user_id,kind,expires_ms)",
      ],
    },
    {
      version: 32,
      id: "user-budget-thresholds",
      statements: [
        "CREATE TABLE budget_threshold_crossings(budget_id TEXT NOT NULL,month_start INTEGER NOT NULL,zone TEXT NOT NULL,threshold INTEGER NOT NULL CHECK(threshold IN(80,100)),event_id TEXT NOT NULL UNIQUE REFERENCES insight_events(id),group_id TEXT NOT NULL,grant_id TEXT REFERENCES proactive_grants(id),crossing_json TEXT NOT NULL CHECK(json_valid(crossing_json)),PRIMARY KEY(budget_id,month_start,zone,threshold)) STRICT",
        "CREATE INDEX budget_crossing_group ON budget_threshold_crossings(group_id,threshold)",
        "CREATE TABLE budget_alert_groups(id TEXT PRIMARY KEY REFERENCES insight_events(id),grant_id TEXT NOT NULL REFERENCES proactive_grants(id),parameter TEXT NOT NULL,deadline_ms INTEGER NOT NULL,due_ms INTEGER NOT NULL) STRICT",
        "CREATE INDEX budget_alert_due ON budget_alert_groups(due_ms)",
        "CREATE TRIGGER frozen_budget_crossing BEFORE UPDATE ON budget_threshold_crossings BEGIN SELECT RAISE(ABORT,'immutable_budget_threshold'); END",
      ],
    },
    {
      version: 33,
      id: "native-recurring-digests",
      statements: [
        "ALTER TABLE budget_alert_groups RENAME TO category_alert_groups",
        "CREATE TABLE recurring_digest_instructions(user_id TEXT PRIMARY KEY REFERENCES users(id),id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,grant_id TEXT NOT NULL REFERENCES proactive_grants(id),acceptance_from_ms INTEGER NOT NULL,next_ms INTEGER) STRICT",
        "CREATE TABLE recurring_digest_claims(confirmation_id TEXT PRIMARY KEY,from_ms INTEGER NOT NULL,to_ms INTEGER NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('included','suppressed','invalid','excluded'))) STRICT",
        "CREATE TABLE recurring_digest_days(from_ms INTEGER NOT NULL,to_ms INTEGER NOT NULL,event_id TEXT REFERENCES insight_events(id),PRIMARY KEY(from_ms,to_ms)) STRICT",
        "CREATE TRIGGER new_digest_source AFTER UPDATE OF evaluated_at_ms ON recurring_evaluation_records WHEN NEW.kind='progress' AND NEW.phase='complete' AND NEW.evaluated_at_ms IS NOT NULL BEGIN UPDATE recurring_digest_instructions SET next_ms=min(coalesce(next_ms,NEW.evaluated_at_ms),NEW.evaluated_at_ms) WHERE user_id=NEW.user_id; END",
        "CREATE TRIGGER initial_digest_source AFTER INSERT ON recurring_evaluation_records WHEN NEW.kind='progress' AND NEW.phase='complete' AND NEW.evaluated_at_ms IS NOT NULL BEGIN UPDATE recurring_digest_instructions SET next_ms=min(coalesce(next_ms,NEW.evaluated_at_ms),NEW.evaluated_at_ms) WHERE user_id=NEW.user_id; END",
      ],
    },
    {
      version: 34,
      id: "hosted-terminal-retention",
      statements: [
        "CREATE INDEX retained_turn_content ON hosted_turns(terminal_ms,id) WHERE terminal_ms IS NOT NULL AND request_text<>''",
        "CREATE INDEX retained_compactions ON hosted_agent_sessions(active_ms,id) WHERE compacted_text IS NOT NULL",
      ],
    },
    {
      version: 35,
      id: "weekly-summary-owner",
      statements: [
        "CREATE TABLE weekly_schedules(user_id TEXT PRIMARY KEY REFERENCES users(id),id TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,grant_id TEXT NOT NULL REFERENCES proactive_grants(id),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),next_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE weekly_summary_reports(id TEXT PRIMARY KEY REFERENCES insight_events(id),grant_id TEXT NOT NULL REFERENCES proactive_grants(id),presentation TEXT NOT NULL CHECK(json_valid(presentation)),payload TEXT NOT NULL CHECK(json_valid(payload)),expires_ms INTEGER NOT NULL) STRICT",
        "CREATE INDEX weekly_report_expiry ON weekly_summary_reports(expires_ms)",
        "CREATE TABLE weekly_attention(grant_id TEXT PRIMARY KEY REFERENCES proactive_grants(id),unanswered INTEGER NOT NULL DEFAULT 0,last_reply_ms INTEGER NOT NULL DEFAULT 0,ask_ms INTEGER,question_id TEXT REFERENCES reminder_disclosures(id),question_delivered_ms INTEGER,paused_ms INTEGER,notice_turn TEXT REFERENCES hosted_turns(id),notice_delivered INTEGER NOT NULL DEFAULT 0) STRICT",
        "ALTER TABLE reminder_disclosures ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reminder_attention ADD COLUMN notice_turn TEXT REFERENCES hosted_turns(id)",
        "ALTER TABLE reminder_attention ADD COLUMN notice_delivered INTEGER NOT NULL DEFAULT 0",
      ],
    },
    {
      version: 36,
      id: "pending-delivery-observation",
      statements: [
        "ALTER TABLE reminder_deliveries ADD COLUMN created_ms INTEGER",
        "UPDATE reminder_deliveries SET created_ms=(SELECT scheduled_ms FROM insight_events e WHERE e.id=reminder_deliveries.id)",
        "ALTER TABLE reminder_deliveries ADD COLUMN observation_kind TEXT NOT NULL DEFAULT 'proactivity-delivery'",
        "ALTER TABLE reminder_deliveries ADD COLUMN terminal_receipt INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE reminder_disclosures ADD COLUMN terminal_receipt INTEGER NOT NULL DEFAULT 0",
        "UPDATE reminder_deliveries SET observation_kind='weekly-summary' WHERE grant_id IN (SELECT id FROM proactive_grants WHERE kind='weekly-summary')",
        "UPDATE reminder_deliveries SET terminal_receipt=1 WHERE EXISTS(SELECT 1 FROM whatsapp_deliveries w WHERE w.user_id=reminder_deliveries.user_id AND w.operation_id=reminder_deliveries.id AND w.family='proactivity' AND w.state IN ('delivered','rejected'))",
        "UPDATE reminder_disclosures SET terminal_receipt=1 WHERE EXISTS(SELECT 1 FROM whatsapp_deliveries w WHERE w.user_id=reminder_disclosures.user_id AND w.operation_id=reminder_disclosures.id AND w.family='disclosure' AND w.state IN ('delivered','rejected'))",
        "CREATE TRIGGER observe_delivery_receipt AFTER UPDATE OF state ON whatsapp_deliveries WHEN NEW.family='proactivity' AND NEW.state IN ('delivered','rejected') BEGIN UPDATE reminder_deliveries SET terminal_receipt=1 WHERE id=NEW.operation_id AND user_id=NEW.user_id; END",
        "CREATE TRIGGER observe_disclosure_receipt AFTER UPDATE OF state ON whatsapp_deliveries WHEN NEW.family='disclosure' AND NEW.state IN ('delivered','rejected') BEGIN UPDATE reminder_disclosures SET terminal_receipt=1 WHERE id=NEW.operation_id AND user_id=NEW.user_id; END",
        "CREATE INDEX pending_delivery_observation ON reminder_deliveries(observation_kind,created_ms,id) WHERE terminal_receipt=0 AND state IN('ready','claimed')",
        "CREATE INDEX pending_disclosure_observation ON reminder_disclosures(kind,created_ms,id) WHERE terminal_receipt=0 AND state IN('ready','claimed')",
      ],
    },
    {
      version: 37,
      id: "native-category-disclosure-opportunities",
      statements: [
        "CREATE TABLE insight_contacts(user_id TEXT PRIMARY KEY REFERENCES users(id),portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,endpoint TEXT NOT NULL,observed_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE category_opportunities(user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','new-recurring-series')),source TEXT NOT NULL,offer_id TEXT,next_ms INTEGER,closed_ms INTEGER,PRIMARY KEY(user_id,kind)) STRICT",
        "CREATE TRIGGER first_budget_offer AFTER INSERT ON budgets BEGIN INSERT OR IGNORE INTO category_opportunities(user_id,kind,source,next_ms) VALUES(NEW.user_id,'budget-threshold',NEW.id,(SELECT NEW.created_at_ms FROM insight_contacts c WHERE c.user_id=NEW.user_id)); END",
        "INSERT INTO category_opportunities(user_id,kind,source) SELECT user_id,'budget-threshold',id FROM (SELECT user_id,id,row_number() OVER(PARTITION BY user_id ORDER BY created_at_ms,id) AS ordinal FROM budgets) WHERE ordinal=1",
      ],
    },
    {
      version: 38,
      id: "support-recovery-case-retention",
      statements: [
        "ALTER TABLE support_recovery_cases ADD COLUMN retained_until_ms INTEGER GENERATED ALWAYS AS (unixepoch(closed_at_ms/1000,'unixepoch','+24 months','floor')*1000+(closed_at_ms%1000)) VIRTUAL",
        "CREATE INDEX support_case_retention ON support_recovery_cases(retained_until_ms,id)",
        "CREATE TRIGGER immutable_support_case BEFORE UPDATE ON support_recovery_cases BEGIN SELECT RAISE(ABORT,'immutable support decision'); END",
      ],
    },
    {
      version: 39,
      id: "immutable-manual-pro-grant-evidence",
      statements: [
        "CREATE INDEX pro_grant_user_sequence ON pro_grant_events(user_id,sequence DESC)",
        "CREATE TRIGGER pro_grant_events_immutable BEFORE UPDATE ON pro_grant_events BEGIN SELECT RAISE(ABORT,'Pro grant evidence is immutable'); END",
      ],
    },
    {
      version: 40,
      id: "beta-operator-command-evidence",
      statements: [
        "ALTER TABLE pro_grant_events ADD COLUMN request_id TEXT",
        "ALTER TABLE pro_grant_events ADD COLUMN operator_issuer TEXT",
        "ALTER TABLE pro_grant_events ADD COLUMN operator_subject TEXT",
        "ALTER TABLE pro_grant_events ADD COLUMN mailbox_revision INTEGER",
        "CREATE UNIQUE INDEX pro_grant_request ON pro_grant_events(request_id) WHERE request_id IS NOT NULL",
      ],
    },
    {
      version: 41,
      id: "connection-erasure-suppression-repair",
      statements: connectionGrantCleanupSchema(),
    },
  ],
};

type RecoveryFamily<E, R> = Effect.Effect<Readonly<{ attempted: number; failed: number }>, E, R>;

export const recoverUserWork = <E, R>(
  jobs:
    | ReadonlyArray<RecoveryFamily<E, R>>
    | {
        families: ReadonlyArray<RecoveryFamily<E, R>>;
        hosted: RecoveryFamily<E, R>;
        timeoutMs: number;
      }
): Effect.Effect<
  Readonly<{ failedFamilies: number; attempted: number; failedOffers: number }>,
  never,
  R
> =>
  Effect.forEach(
    "hosted" in jobs
      ? [
          ...jobs.families.map((family) => family.pipe(Effect.timeout("45 seconds"))),
          jobs.hosted.pipe(Effect.timeout(jobs.timeoutMs)),
        ]
      : jobs.map((family) => family.pipe(Effect.timeout("45 seconds"))),
    (family) => Effect.exit(family),
    {
      concurrency: 4,
    }
  ).pipe(
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

export const observeUserRegistration = Effect.fn(function* (
  maintenance: Pick<DurableObjectNamespace, "getByName">,
  owns: (id: string) => boolean,
  settings: NativeAcceptanceSettings
) {
  const sql = yield* SqliteClient;

  if (settings.NATIVE_STORAGE_ADMISSION === "closed") {
    const credentials =
      yield* sql`SELECT issuer,subject FROM provider_credentials WHERE user_id IN(SELECT id FROM users LIMIT 1)`;

    if (
      !credentials.some(
        (credential) =>
          Predicate.isString(credential.issuer) &&
          Predicate.isString(credential.subject) &&
          acceptanceSubject({
            revision: acceptanceProviderRevision(settings),
            issuer: credential.issuer,
            subject: credential.subject,
          })
      )
    ) {
      return "isolated" as const;
    }
  }

  const [row] = yield* sql`SELECT id,lifetime_registered FROM users LIMIT 1`;

  if (row === undefined) return "empty" as const;

  const user = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      id: UserId,
      lifetime_registered: Schema.Literals([0, 1]),
    })
  )(row);

  if (!owns(user.id)) return "unavailable" as const;

  if (user.lifetime_registered === 1) return "registered" as const;
  yield* registerUserLifetime(maintenance, user.id);

  const confirmed = yield* sql`UPDATE users SET lifetime_registered=1 WHERE id=${user.id}
    AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${user.id}) RETURNING id`;

  return confirmed.length === 1 ? ("registered" as const) : ("unavailable" as const);
});

export const registerUserLifetime: typeof registerReservedLifetime = (maintenance, userId) =>
  registerReservedLifetime(maintenance, userId);
