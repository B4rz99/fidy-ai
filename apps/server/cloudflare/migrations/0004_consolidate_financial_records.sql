-- Preserve enrollment/source identity, reversible membership, and independently verified provider evidence.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP TRIGGER "billing_attempt_user_collection_guard";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_guard";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_guard_insert";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_requires_claim";
--> statement-breakpoint

DROP TRIGGER "budget_capture_work";
--> statement-breakpoint

DROP TRIGGER "budget_correction_work";
--> statement-breakpoint

DROP TRIGGER "budget_link_work";
--> statement-breakpoint

DROP TRIGGER "budget_unlink_work";
--> statement-breakpoint

DROP TRIGGER "card_source_immutable";
--> statement-breakpoint

DROP TRIGGER "weekly_price_notice";
--> statement-breakpoint

DROP TRIGGER "transaction_user_decisions";
--> statement-breakpoint

DROP TRIGGER "transaction_fact_update";
--> statement-breakpoint

DROP TRIGGER "transaction_fact_insert";
--> statement-breakpoint

DROP TRIGGER "transaction_fact_delete";
--> statement-breakpoint

DROP TRIGGER "transaction_fact_attestation";
--> statement-breakpoint

DROP TRIGGER "refund_reservation_guard";
--> statement-breakpoint

DROP TRIGGER "refund_claim_requires_pending";
--> statement-breakpoint

DROP TRIGGER "payment_source_method_guard";
--> statement-breakpoint

DROP TRIGGER "payment_enrollment_method_immutable";
--> statement-breakpoint

DROP TRIGGER "payment_attempt_method_guard";
--> statement-breakpoint

DROP TRIGGER "linked_transaction_no_delete";
--> statement-breakpoint

DROP TRIGGER "forwarded_email_companions_valid_update";
--> statement-breakpoint

DROP TRIGGER "forwarded_email_companions_valid_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_transaction_reconciliation_members_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_transaction_corrections_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_source_attestations_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_card_payment_sources_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_card_enrollments_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_provider_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_event_candidates_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transactions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transactions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transaction_reconciliation_members_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transaction_reconciliation_members_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_transaction_reconciliation_members_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_payment_sources_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_payment_sources_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_payment_sources_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_enrollments_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_enrollments_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_card_enrollments_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_delete";
--> statement-breakpoint

DROP TRIGGER "deleted_transaction_no_update";
--> statement-breakpoint

DROP TRIGGER "deleted_transaction_no_link";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_unlink_member";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_link_member";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_deleted_transaction";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_corrected_transaction";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_corrected_source";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_capture";
--> statement-breakpoint

DROP TRIGGER "dashboard_projection_attested_source";
--> statement-breakpoint

DROP TRIGGER "card_source_retired_insert";
--> statement-breakpoint

DROP TRIGGER "card_source_requires_claim";
--> statement-breakpoint

DROP TRIGGER "card_enrollment_preparation_limit";
--> statement-breakpoint

DROP TRIGGER "card_enrollment_evidence_immutable";
--> statement-breakpoint

DROP TRIGGER "billing_evidence_reject_foreign_id";
--> statement-breakpoint

DROP TRIGGER "billing_evidence_immutable_identity";
--> statement-breakpoint

DROP TRIGGER "billing_evidence_approval_monotonic";
--> statement-breakpoint

DROP TRIGGER "billing_checkout_response_guard";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_retired_source";
--> statement-breakpoint

DROP VIEW "dashboard_effective_source";
--> statement-breakpoint

DROP VIEW "billing_retry_clearances";
--> statement-breakpoint

DROP INDEX "transactions_by_user_occurrence";
--> statement-breakpoint

DROP INDEX "transactions_by_user_creation";
--> statement-breakpoint

DROP INDEX "payment_source_active_user";
--> statement-breakpoint

DROP INDEX "payment_authorization_once";
--> statement-breakpoint

DROP INDEX "card_enrollment_request";
--> statement-breakpoint

DROP INDEX "card_enrollment_active_user";
--> statement-breakpoint

DROP INDEX "billing_provider_transaction_attempt";
--> statement-breakpoint

ALTER TABLE card_payment_sources RENAME COLUMN id TO payment_source_id;
--> statement-breakpoint

CREATE TABLE _enrollment_rows AS SELECT rowid AS original_rowid,* FROM card_enrollments;
--> statement-breakpoint

DROP TABLE card_enrollments;
--> statement-breakpoint

CREATE TABLE "card_enrollments" (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'creating', 'available', 'refused', 'expired', 'verifying')),
  payment_source_mode TEXT NOT NULL CHECK (payment_source_mode IN ('create', 'reuse')),
  contracts_json TEXT NOT NULL,
  disclosure_json TEXT NOT NULL,
  prepared_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = prepared_at_ms + 900000),
  accepted_at_ms INTEGER,
  payment_request_id TEXT CHECK (payment_request_id IS NULL OR length(payment_request_id) = 36),
  wompi_candidate_source_id INTEGER UNIQUE CHECK (wompi_candidate_source_id > 0),
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts BETWEEN 0 AND 8),
  last_verification_at_ms INTEGER,
  refusal_reason TEXT CHECK (refusal_reason IN ('provider-declined', 'provider-error', 'terms-changed')),
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card', 'nequi', 'daviplata')),
  wompi_environment TEXT CHECK (wompi_environment IN ('sandbox', 'production')),
  authorization_digest TEXT CHECK (authorization_digest IS NULL OR length(authorization_digest) = 64),
payment_source_id TEXT UNIQUE CHECK(payment_source_id IS NULL OR length(payment_source_id)=36),
 source_wompi_id INTEGER UNIQUE CHECK(source_wompi_id IS NULL OR source_wompi_id>0),
 source_billing_email TEXT,source_created_at_ms INTEGER,source_retired_at_ms INTEGER CHECK(source_retired_at_ms IS NULL OR source_retired_at_ms>0),
 source_method TEXT CHECK(source_method IN ('card','nequi','daviplata')),
 CHECK((payment_source_id IS NULL AND source_wompi_id IS NULL AND source_billing_email IS NULL AND source_created_at_ms IS NULL AND source_retired_at_ms IS NULL AND source_method IS NULL)
 OR (payment_source_id IS NOT NULL AND source_wompi_id IS NOT NULL AND source_billing_email IS NOT NULL AND source_created_at_ms IS NOT NULL AND source_method IS NOT NULL)),
  CHECK ((status = 'prepared' AND payment_request_id IS NULL AND accepted_at_ms IS NULL)
    OR (status <> 'prepared'))
) STRICT;
--> statement-breakpoint

INSERT INTO card_enrollments(rowid,id,user_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,accepted_at_ms,payment_request_id,wompi_candidate_source_id,verification_attempts,last_verification_at_ms,refusal_reason,method,wompi_environment,authorization_digest,payment_source_id,source_wompi_id,source_billing_email,source_created_at_ms,source_retired_at_ms,source_method) SELECT e.original_rowid,e.id,e.user_id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,e.wompi_environment,e.authorization_digest,s.payment_source_id,s.wompi_source_id,s.billing_email,s.created_at_ms,s.retired_at_ms,s.method FROM _enrollment_rows e LEFT JOIN card_payment_sources s ON s.enrollment_id=e.id;
--> statement-breakpoint

INSERT INTO sql_assertions(scope,accepted) SELECT 'schema_upgrade',0 WHERE EXISTS(SELECT 1 FROM card_payment_sources s LEFT JOIN card_enrollments e ON e.id=s.enrollment_id AND e.user_id=s.user_id WHERE e.id IS NULL);
--> statement-breakpoint

DROP TABLE card_payment_sources;
--> statement-breakpoint

ALTER TABLE card_enrollments RENAME TO card_payment_sources;
--> statement-breakpoint

ALTER TABLE card_payment_sources RENAME TO card_enrollments;
--> statement-breakpoint

DROP TABLE _enrollment_rows;
--> statement-breakpoint

CREATE TABLE _transaction_rows AS SELECT rowid AS original_rowid,* FROM transactions;
--> statement-breakpoint

DROP TABLE transactions;
--> statement-breakpoint

CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  counterparty TEXT,
  category_id TEXT NOT NULL REFERENCES categories(id),
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), user_decisions TEXT NOT NULL DEFAULT '{}', deleted_at_ms INTEGER,
reconciliation_first_id TEXT,reconciliation_second_id TEXT,
 FOREIGN KEY(user_id,reconciliation_first_id,reconciliation_second_id) REFERENCES transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id),
 CHECK((reconciliation_first_id IS NULL AND reconciliation_second_id IS NULL) OR (reconciliation_first_id IS NOT NULL AND reconciliation_second_id IS NOT NULL AND id IN(reconciliation_first_id,reconciliation_second_id))),
 CHECK(reconciliation_first_id IS NULL OR deleted_at_ms IS NULL),
  UNIQUE (user_id, id)
) STRICT;
--> statement-breakpoint

INSERT INTO transactions(rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at,created_at,revision,user_decisions,deleted_at_ms,reconciliation_first_id,reconciliation_second_id) SELECT t.original_rowid,t.id,t.user_id,t.amount,t.currency,t.direction,t.counterparty,t.category_id,t.notes,t.occurred_at,t.created_at,t.revision,t.user_decisions,t.deleted_at_ms,m.first_transaction_id,m.second_transaction_id FROM _transaction_rows t LEFT JOIN transaction_reconciliation_members m ON m.user_id=t.user_id AND m.transaction_id=t.id;
--> statement-breakpoint

DROP TABLE transaction_reconciliation_members;
--> statement-breakpoint

DROP TABLE _transaction_rows;
--> statement-breakpoint

CREATE TABLE _provider_rows AS SELECT rowid AS original_rowid,* FROM billing_provider_transactions;
--> statement-breakpoint

DROP TABLE billing_provider_transactions;
--> statement-breakpoint

CREATE TABLE billing_provider_transactions (
 transaction_id TEXT PRIMARY KEY NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 128),
 attempt_id TEXT REFERENCES billing_attempts(id),
 lookup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(lookup_attempts>=0),last_checked_at_ms INTEGER,
 status TEXT CHECK(status IN ('PENDING','APPROVED','DECLINED','VOIDED','ERROR')),
 first_observed_at_ms INTEGER,negative_observed_at_ms INTEGER,finalized_at_ms INTEGER,
 evidence_transaction_id TEXT GENERATED ALWAYS AS(CASE WHEN status IS NOT NULL THEN transaction_id END) VIRTUAL UNIQUE,
event_received_at_ms INTEGER,event_signed_at INTEGER,event_signed_status TEXT,
 event_lookup_attempts INTEGER CHECK(event_lookup_attempts>=0),event_last_checked_at_ms INTEGER,event_resolved_at_ms INTEGER,
 CHECK(attempt_id IS NOT NULL OR event_received_at_ms IS NOT NULL),
 CHECK(attempt_id IS NOT NULL OR (status IS NULL AND first_observed_at_ms IS NULL AND negative_observed_at_ms IS NULL AND finalized_at_ms IS NULL)),
 CHECK((event_received_at_ms IS NULL AND event_signed_at IS NULL AND event_signed_status IS NULL AND event_lookup_attempts IS NULL AND event_last_checked_at_ms IS NULL AND event_resolved_at_ms IS NULL)
 OR (event_received_at_ms IS NOT NULL AND event_signed_at IS NOT NULL AND event_signed_status IS NOT NULL AND event_lookup_attempts IS NOT NULL)),
 CHECK((status IS NULL AND first_observed_at_ms IS NULL AND negative_observed_at_ms IS NULL AND finalized_at_ms IS NULL)
  OR (status IS NOT NULL AND first_observed_at_ms IS NOT NULL AND (status<>'APPROVED' OR finalized_at_ms IS NOT NULL)))
) STRICT;
--> statement-breakpoint

INSERT INTO billing_provider_transactions(rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms,event_received_at_ms,event_signed_at,event_signed_status,event_lookup_attempts,event_last_checked_at_ms,event_resolved_at_ms) SELECT p.original_rowid,p.transaction_id,p.attempt_id,p.lookup_attempts,p.last_checked_at_ms,p.status,p.first_observed_at_ms,p.negative_observed_at_ms,p.finalized_at_ms,e.received_at_ms,e.signed_at,e.signed_status,e.lookup_attempts,e.last_checked_at_ms,e.resolved_at_ms FROM _provider_rows p LEFT JOIN billing_event_candidates e ON e.transaction_id=p.transaction_id;
--> statement-breakpoint

INSERT INTO billing_provider_transactions(transaction_id,event_received_at_ms,event_signed_at,event_signed_status,event_lookup_attempts,event_last_checked_at_ms,event_resolved_at_ms) SELECT e.transaction_id,e.received_at_ms,e.signed_at,e.signed_status,e.lookup_attempts,e.last_checked_at_ms,e.resolved_at_ms FROM billing_event_candidates e WHERE NOT EXISTS(SELECT 1 FROM billing_provider_transactions p WHERE p.transaction_id=e.transaction_id);
--> statement-breakpoint

DROP TABLE billing_event_candidates;
--> statement-breakpoint

DROP TABLE _provider_rows;
--> statement-breakpoint

CREATE VIEW verified_payment_sources AS SELECT rowid,payment_source_id AS id,user_id,id AS enrollment_id,source_wompi_id AS wompi_source_id,source_billing_email AS billing_email,source_created_at_ms AS created_at_ms,source_retired_at_ms AS retired_at_ms,source_method AS method FROM card_enrollments WHERE payment_source_id IS NOT NULL;
--> statement-breakpoint

CREATE VIEW reconciled_transactions AS SELECT rowid,user_id,id AS transaction_id,reconciliation_first_id AS first_transaction_id,reconciliation_second_id AS second_transaction_id FROM transactions WHERE reconciliation_first_id IS NOT NULL;
--> statement-breakpoint

CREATE VIEW billing_callback_hints AS SELECT rowid,transaction_id,event_received_at_ms AS received_at_ms,event_signed_at AS signed_at,event_signed_status AS signed_status,event_lookup_attempts AS lookup_attempts,event_last_checked_at_ms AS last_checked_at_ms,event_resolved_at_ms AS resolved_at_ms FROM billing_provider_transactions WHERE event_received_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_provider_transaction_attempt ON billing_provider_transactions(attempt_id,status);
--> statement-breakpoint

CREATE UNIQUE INDEX card_enrollment_active_user ON card_enrollments(user_id)
WHERE status IN ('preparing', 'prepared', 'creating', 'verifying');
--> statement-breakpoint

CREATE UNIQUE INDEX card_enrollment_request ON card_enrollments(user_id, payment_request_id)
WHERE payment_request_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX payment_authorization_once ON card_enrollments(authorization_digest)
WHERE authorization_digest IS NOT NULL;
--> statement-breakpoint

CREATE INDEX transactions_by_user_creation ON transactions(user_id, created_at);
--> statement-breakpoint

CREATE INDEX transactions_by_user_occurrence ON transactions(user_id, occurred_at DESC, created_at DESC, id DESC);
--> statement-breakpoint

CREATE VIEW billing_retry_clearances AS
SELECT a.id AS attempt_id FROM billing_attempts a
JOIN (SELECT rowid,id AS attempt_id,checkout_transaction_id AS transaction_id FROM billing_attempts WHERE checkout_transaction_id IS NOT NULL) response ON response.attempt_id=a.id
JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) evidence ON evidence.transaction_id=response.transaction_id AND evidence.attempt_id=a.id
WHERE a.status='failed' AND evidence.status='DECLINED' AND evidence.finalized_at_ms IS NOT NULL
  AND evidence.negative_observed_at_ms<=a.finalized_at_ms-180000
  AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms FROM billing_provider_transactions) candidate
    WHERE candidate.attempt_id=a.id AND candidate.transaction_id<>response.transaction_id)
  AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid WHERE paid.attempt_id=a.id);
--> statement-breakpoint

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
  WHERE retained.deleted_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM reconciled_transactions member
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
  WHERE EXISTS (SELECT 1 FROM reconciled_transactions first_member
    WHERE first_member.user_id = decision.user_id
      AND first_member.transaction_id = decision.first_transaction_id)
    AND EXISTS (SELECT 1 FROM reconciled_transactions second_member
      WHERE second_member.user_id = decision.user_id
        AND second_member.transaction_id = decision.second_transaction_id)
)
SELECT * FROM effective_transaction;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_retired_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM verified_payment_sources source WHERE source.id=NEW.payment_source_id AND source.retired_at_ms IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_retired');
END;
--> statement-breakpoint

CREATE TRIGGER billing_checkout_response_guard BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NULL AND NEW.checkout_transaction_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) arm ON arm.attempt_id=a.id
  JOIN (SELECT rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms FROM billing_provider_transactions) candidate ON candidate.attempt_id=a.id
  JOIN verified_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.id AND candidate.transaction_id=NEW.checkout_transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER card_enrollment_evidence_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.user_id <> OLD.user_id OR NEW.price_id <> OLD.price_id
  OR ((OLD.status <> 'preparing' OR NEW.status <> 'prepared')
    AND (NEW.payment_source_mode <> OLD.payment_source_mode
      OR NEW.contracts_json <> OLD.contracts_json OR NEW.disclosure_json <> OLD.disclosure_json))
  OR NEW.prepared_at_ms <> OLD.prepared_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR (OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS NOT OLD.payment_request_id)
BEGIN SELECT RAISE(ABORT, 'card_enrollment_evidence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER card_enrollment_preparation_limit BEFORE INSERT ON card_enrollments
WHEN (SELECT count(*) FROM card_enrollments WHERE user_id = NEW.user_id
  AND prepared_at_ms > NEW.prepared_at_ms - 3600000) >= 12
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_attested_source AFTER INSERT ON source_attestations
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
      FROM reconciled_transactions member
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
        FROM reconciled_transactions member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_capture AFTER INSERT ON transactions
BEGIN
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id AND id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_corrected_source AFTER INSERT ON transaction_corrections
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
      FROM reconciled_transactions member
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
        FROM reconciled_transactions member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_corrected_transaction AFTER UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms)
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.id, (SELECT decision.visible_transaction_id
      FROM reconciled_transactions member
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
        FROM reconciled_transactions member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.id));
END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_deleted_transaction AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id AND id = OLD.id;
END;
--> statement-breakpoint

CREATE TRIGGER deleted_transaction_no_update BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND OLD.deleted_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'transaction_deleted'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_insert BEFORE INSERT ON billing_provider_transactions
WHEN NEW.attempt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_update BEFORE UPDATE ON billing_provider_transactions
WHEN (NEW.transaction_id IS NOT OLD.transaction_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.lookup_attempts IS NOT OLD.lookup_attempts OR NEW.last_checked_at_ms IS NOT OLD.last_checked_at_ms OR NEW.status IS NOT OLD.status OR NEW.first_observed_at_ms IS NOT OLD.first_observed_at_ms OR NEW.negative_observed_at_ms IS NOT OLD.negative_observed_at_ms OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_delete BEFORE DELETE ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_insert BEFORE INSERT ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_update BEFORE UPDATE ON card_enrollments
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.price_id IS NOT OLD.price_id OR NEW.billing_email IS NOT OLD.billing_email OR NEW.status IS NOT OLD.status OR NEW.payment_source_mode IS NOT OLD.payment_source_mode OR NEW.contracts_json IS NOT OLD.contracts_json OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.accepted_at_ms IS NOT OLD.accepted_at_ms OR NEW.payment_request_id IS NOT OLD.payment_request_id OR NEW.wompi_candidate_source_id IS NOT OLD.wompi_candidate_source_id OR NEW.verification_attempts IS NOT OLD.verification_attempts OR NEW.last_verification_at_ms IS NOT OLD.last_verification_at_ms OR NEW.refusal_reason IS NOT OLD.refusal_reason OR NEW.method IS NOT OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment OR NEW.authorization_digest IS NOT OLD.authorization_digest) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transactions_delete BEFORE DELETE ON transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transactions_insert BEFORE INSERT ON transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transactions_update BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_provider_transactions','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms",'status',OLD.status,'first_observed_at_ms',OLD.first_observed_at_ms,'negative_observed_at_ms',OLD.negative_observed_at_ms,'finalized_at_ms',OLD.finalized_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_card_enrollments_delete BEFORE DELETE ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_enrollments','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'price_id',OLD."price_id",'billing_email',OLD."billing_email",'status',OLD."status",'payment_source_mode',OLD."payment_source_mode",'contracts_json',OLD."contracts_json",'disclosure_json',OLD."disclosure_json",'prepared_at_ms',OLD."prepared_at_ms",'expires_at_ms',OLD."expires_at_ms",'accepted_at_ms',OLD."accepted_at_ms",'payment_request_id',OLD."payment_request_id",'wompi_candidate_source_id',OLD."wompi_candidate_source_id",'verification_attempts',OLD."verification_attempts",'last_verification_at_ms',OLD."last_verification_at_ms",'refusal_reason',OLD."refusal_reason",'method',OLD."method",'wompi_environment',OLD."wompi_environment")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_source_attestations_delete BEFORE DELETE ON source_attestations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'source_attestations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'transaction_id',OLD."transaction_id",'kind',OLD."kind",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'interpretation_revision',OLD."interpretation_revision",'created_at',OLD."created_at",'statement_submission_id',OLD."statement_submission_id",'statement_record_number',OLD."statement_record_number",'statement_content_hash',OLD."statement_content_hash",'source_format',OLD."source_format",'received_email_id',OLD."received_email_id",'message_content_sha256',OLD."message_content_sha256",'message_evidence',OLD."message_evidence",'deterministic_interpretation',OLD."deterministic_interpretation",'extractor_revision',OLD."extractor_revision",'review_item_id',OLD."review_item_id",'user_provided_fields',OLD."user_provided_fields")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_transaction_corrections_delete BEFORE DELETE ON transaction_corrections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_corrections','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'transaction_id',OLD."transaction_id",'previous_revision',OLD."previous_revision",'changed_fields',OLD."changed_fields",'before_facts',OLD."before_facts",'after_facts',OLD."after_facts",'corrected_at',OLD."corrected_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_transactions_delete BEFORE DELETE ON transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transactions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'amount',OLD."amount",'currency',OLD."currency",'direction',OLD."direction",'counterparty',OLD."counterparty",'category_id',OLD."category_id",'notes',OLD."notes",'occurred_at',OLD."occurred_at",'created_at',OLD."created_at",'revision',OLD."revision",'user_decisions',OLD."user_decisions",'deleted_at_ms',OLD."deleted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_companions_valid_insert BEFORE INSERT ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_companions_valid_update BEFORE UPDATE ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER linked_transaction_no_delete BEFORE UPDATE OF deleted_at_ms ON transactions
WHEN NEW.deleted_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM reconciled_transactions WHERE user_id = OLD.user_id AND transaction_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'transaction_linked'); END;
--> statement-breakpoint

CREATE TRIGGER payment_attempt_method_guard BEFORE INSERT ON billing_attempts
WHEN NOT EXISTS (SELECT 1 FROM card_enrollments AS e
  JOIN verified_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN card_enrollments AS origin ON origin.id = s.enrollment_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id AND e.method = s.method
    AND (e.wompi_environment = NEW.wompi_environment OR (e.wompi_environment IS NULL AND e.method = 'card'))
    AND (origin.wompi_environment = NEW.wompi_environment OR (origin.wompi_environment IS NULL AND origin.method = 'card'))
    AND NOT EXISTS (SELECT 1 FROM billing_attempts AS prior
      WHERE prior.payment_source_id = s.id AND prior.wompi_environment <> NEW.wompi_environment))
BEGIN
 SELECT RAISE(ABORT, 'payment_attempt_method_mismatch');
END;
--> statement-breakpoint

CREATE TRIGGER payment_enrollment_method_immutable BEFORE UPDATE ON card_enrollments
WHEN NEW.method <> OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment
  OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS NOT OLD.authorization_digest)
BEGIN SELECT RAISE(ABORT, 'payment_enrollment_method_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER refund_claim_requires_pending BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NULL AND NEW.submission_claimed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r
  JOIN billing_attempts a ON a.id=r.billing_attempt_id
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.transaction_id=r.transaction_id AND e.attempt_id=a.id
  WHERE r.id=NEW.id AND r.status='pending' AND a.status='succeeded'
    AND a.wompi_environment='sandbox' AND e.status='APPROVED'
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence
      WHERE attempt_id=a.id AND status='APPROVED')=1))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NOT EXISTS (SELECT 1 FROM billing_attempts a
  JOIN (SELECT rowid,id AS user_id,subscription_id AS id FROM users WHERE subscription_id IS NOT NULL) s ON s.user_id=a.user_id
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.attempt_id=a.id
  JOIN verified_payment_sources p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND s.id=NEW.subscription_id
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > NEW.original_cents - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR EXISTS (SELECT 1 FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id
    AND original_cents<>NEW.original_cents)
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_attestation AFTER INSERT ON source_attestations BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1,
    time_zone = CASE WHEN NEW.transaction_id = (SELECT id FROM transactions WHERE user_id = NEW.user_id ORDER BY created_at, id LIMIT 1)
      AND (SELECT count(*) FROM source_attestations WHERE user_id = NEW.user_id AND transaction_id = NEW.transaction_id) = 1
      THEN NEW.time_zone ELSE time_zone END
  WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_delete AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = OLD.user_id AND fact_revision IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO dashboard_projection_state(user_id,version,readiness,fact_revision,first_captured_at,time_zone)
  SELECT NEW.user_id,0,'dirty',1,NEW.created_at,time_zone FROM users WHERE id=NEW.user_id
  ON CONFLICT(user_id) DO UPDATE SET fact_revision=coalesce(fact_revision,0)+1,
    first_captured_at=coalesce(first_captured_at,excluded.first_captured_at),
    time_zone=coalesce(dashboard_projection_state.time_zone,excluded.time_zone);
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_update AFTER UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER transaction_user_decisions BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND EXISTS (
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
  (json_extract(OLD.user_decisions, '$.occurredAt') = 1 AND NEW.occurred_at != OLD.occurred_at) OR
  (json_extract(OLD.user_decisions, '$.categoryId') = 1 AND NEW.category_id != OLD.category_id) OR
  (json_extract(OLD.user_decisions, '$.counterparty') = 1 AND NEW.counterparty IS NOT OLD.counterparty) OR
  (json_extract(OLD.user_decisions, '$.notes') = 1 AND NEW.notes IS NOT OLD.notes)
))
BEGIN SELECT RAISE(ABORT, 'transaction_user_decision'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_price_notice AFTER UPDATE OF published_order ON subscription_prices
WHEN NEW.published_order = 1 AND OLD.published_order IS NULL
BEGIN
 INSERT OR IGNORE INTO billing_price_notices (user_id, price_id, created_at_ms)
    SELECT s.user_id, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) s
    JOIN billing_attempts a ON a.id=s.attempt_id AND a.user_id=s.user_id
    JOIN verified_payment_sources source ON source.id=a.payment_source_id AND source.user_id=s.user_id
    WHERE a.billing_period='weekly' AND source.method='card' AND a.price_id<>NEW.id
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) stop WHERE stop.user_id=s.user_id);
END;
--> statement-breakpoint

CREATE TRIGGER budget_unlink_work AFTER UPDATE ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_link_work AFTER INSERT ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_correction_work AFTER UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1;
  INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',OLD.user_id, OLD.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_capture_work AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_requires_claim BEFORE INSERT ON billing_attempts
WHEN NEW.status <> 'pending' OR NEW.finalized_at_ms IS NOT NULL
  OR NOT ((NEW.renewal_attempt_number = 1 AND NEW.previous_paid_attempt_id IS NULL AND NEW.calendar_anchor_ms IS NULL AND NEW.period_starts_at_ms IS NULL
    AND NEW.period_ends_at_ms IS NULL AND EXISTS (
  SELECT 1 FROM card_enrollments AS e
  JOIN verified_payment_sources AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN subscription_prices AS p ON p.id = e.price_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = NEW.user_id
    AND e.status = 'available' AND e.payment_request_id = NEW.payment_request_id
    AND e.price_id = NEW.price_id
    AND NEW.amount = p.amount AND NEW.currency = p.currency
    AND NEW.billing_period = p.billing_period AND NEW.service_market = p.service_market
    AND NEW.tax_treatment = p.tax_treatment
))
    OR (NEW.previous_paid_attempt_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub
  JOIN billing_attempts prior ON prior.id = sub.attempt_id AND prior.user_id = sub.user_id
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) period ON period.attempt_id = prior.id
  JOIN verified_payment_sources source ON source.id = NEW.payment_source_id AND source.user_id = sub.user_id
  JOIN subscription_prices price ON price.id = NEW.price_id AND price.published_order IS NOT NULL
  WHERE sub.user_id = NEW.user_id AND prior.id = NEW.previous_paid_attempt_id
    AND prior.status = 'succeeded'
    AND prior.payment_source_id = source.id AND prior.enrollment_id = NEW.enrollment_id
    AND prior.wompi_environment = NEW.wompi_environment AND prior.time_zone = NEW.time_zone
    AND NEW.renewal_attempt_number = 1 AND NEW.payment_request_id = NEW.id
    AND NEW.period_starts_at_ms = period.ends_at_ms AND NEW.period_ends_at_ms > NEW.period_starts_at_ms
    AND NEW.created_at_ms >= period.ends_at_ms
    AND NEW.calendar_anchor_ms = COALESCE(prior.calendar_anchor_ms, period.starts_at_ms)
    AND price.billing_period = prior.billing_period AND price.service_market = prior.service_market
    AND NEW.amount = price.amount AND NEW.currency = price.currency
    AND NEW.billing_period = price.billing_period AND NEW.service_market = price.service_market
    AND NEW.tax_treatment = price.tax_treatment
    AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
))
    OR (NEW.renewal_attempt_number BETWEEN 2 AND 3 AND EXISTS (
      SELECT 1 FROM billing_attempts first
      JOIN billing_attempts last ON last.previous_paid_attempt_id = first.previous_paid_attempt_id
      JOIN (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub ON sub.attempt_id = first.previous_paid_attempt_id AND sub.user_id = first.user_id
      WHERE first.renewal_attempt_number = 1 AND first.previous_paid_attempt_id = NEW.previous_paid_attempt_id
        AND first.user_id = NEW.user_id AND last.renewal_attempt_number = NEW.renewal_attempt_number - 1
        AND last.status = 'failed' AND first.enrollment_id = NEW.enrollment_id
        AND first.payment_source_id = NEW.payment_source_id AND first.price_id = NEW.price_id
        AND first.amount = NEW.amount AND first.currency = NEW.currency
        AND first.billing_period = NEW.billing_period AND first.service_market = NEW.service_market
        AND first.tax_treatment = NEW.tax_treatment AND first.time_zone = NEW.time_zone
        AND first.wompi_environment = NEW.wompi_environment AND NEW.payment_request_id = NEW.id
        AND first.calendar_anchor_ms = NEW.calendar_anchor_ms
        AND first.period_starts_at_ms = NEW.period_starts_at_ms AND first.period_ends_at_ms = NEW.period_ends_at_ms
        AND NEW.created_at_ms >= first.period_starts_at_ms + (NEW.renewal_attempt_number - 1) * 86400000
        AND NEW.created_at_ms < first.period_starts_at_ms + 259200000
        AND NOT EXISTS (SELECT 1 FROM billing_attempts sibling WHERE sibling.previous_paid_attempt_id = first.previous_paid_attempt_id
          AND (sibling.status <> 'failed' OR sibling.renewal_attempt_number >= NEW.renewal_attempt_number))
        AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
    )))
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_invalid_claim');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard_insert BEFORE INSERT ON users
WHEN NEW.cancellation_cancelled_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN verified_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.id AND a.id=NEW.cancellation_paid_attempt_id AND a.payment_source_id=NEW.cancellation_payment_source_id
 AND NEW.cancellation_paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.cancellation_source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard BEFORE UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NULL AND NEW.cancellation_cancelled_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN verified_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.id AND a.id=NEW.cancellation_paid_attempt_id AND a.payment_source_id=NEW.cancellation_payment_source_id
 AND NEW.cancellation_paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.cancellation_source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempts AS prior
  WHERE prior.user_id=NEW.user_id
    AND (prior.status='pending' OR (prior.status='failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,no_charge_reference AS wompi_reference,no_charge_environment AS wompi_environment,no_charge_case_id AS provider_case_id,no_charge_operator_id AS operator_id,no_charge_confirmed_at_ms AS confirmed_at_ms FROM billing_attempts WHERE no_charge_confirmed_at_ms IS NOT NULL) clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempts success
        JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN
 SELECT RAISE(ABORT, 'billing_user_collection_unresolved');
END;
--> statement-breakpoint

CREATE UNIQUE INDEX payment_source_active_user ON card_enrollments(user_id) WHERE payment_source_id IS NOT NULL AND source_retired_at_ms IS NULL;
--> statement-breakpoint

CREATE INDEX reconciliation_members_by_pair ON transactions(user_id,reconciliation_first_id,reconciliation_second_id,id) WHERE reconciliation_first_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_callback_pending ON billing_provider_transactions(event_resolved_at_ms,event_received_at_ms,event_last_checked_at_ms) WHERE event_received_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_enrollments WHEN OLD.payment_source_id IS NOT NULL AND (NEW.payment_source_id IS NOT OLD.payment_source_id OR NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.source_wompi_id IS NOT OLD.source_wompi_id OR NEW.source_billing_email IS NOT OLD.source_billing_email OR NEW.source_created_at_ms IS NOT OLD.source_created_at_ms OR NEW.source_retired_at_ms IS NOT OLD.source_retired_at_ms OR NEW.source_method IS NOT OLD.source_method) AND NOT(NEW.payment_source_id IS NULL) AND (NEW.payment_source_id<>OLD.payment_source_id OR NEW.user_id<>OLD.user_id OR NEW.id<>OLD.id
  OR NEW.source_wompi_id<>OLD.source_wompi_id OR NEW.source_billing_email<>OLD.source_billing_email
  OR NEW.source_created_at_ms<>OLD.source_created_at_ms OR NEW.source_method<>OLD.source_method
  OR OLD.source_retired_at_ms IS NOT NULL OR NEW.source_retired_at_ms IS NULL
  OR OLD.source_method<>'card'
  OR NOT EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.payment_source_id)
  OR EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub WHERE sub.user_id=OLD.user_id)
  OR EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.payment_source_id
    AND (a.status<>'failed'
      OR EXISTS (SELECT 1 FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status IN ('PENDING','APPROVED'))
      OR (NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=a.id)
        AND NOT (a.no_charge_confirmed_at_ms IS NOT NULL AND a.no_charge_reference=a.wompi_reference AND a.no_charge_environment=a.wompi_environment))))) BEGIN SELECT RAISE(ABORT,'card_source_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER card_source_requires_claim BEFORE UPDATE ON card_enrollments WHEN OLD.payment_source_id IS NULL AND NEW.payment_source_id IS NOT NULL AND NOT(OLD.status IN('creating','verifying') AND OLD.payment_source_mode='create' AND NEW.source_billing_email=OLD.billing_email AND NEW.source_wompi_id IS OLD.wompi_candidate_source_id AND NEW.source_retired_at_ms IS NULL) BEGIN SELECT RAISE(ABORT,'card_source_invalid_claim'); END;
--> statement-breakpoint

CREATE TRIGGER payment_source_method_guard BEFORE UPDATE ON card_enrollments WHEN OLD.payment_source_id IS NULL AND NEW.payment_source_id IS NOT NULL AND (NEW.source_method<>OLD.method OR (OLD.wompi_environment IS NULL AND OLD.method<>'card')) BEGIN SELECT RAISE(ABORT,'payment_source_method_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER card_source_no_insert BEFORE INSERT ON card_enrollments WHEN NEW.payment_source_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'card_source_invalid_claim'); END;
--> statement-breakpoint

CREATE TRIGGER deleted_transaction_no_link BEFORE UPDATE OF reconciliation_first_id,reconciliation_second_id ON transactions WHEN NEW.reconciliation_first_id IS NOT NULL AND NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'transaction_deleted'); END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_link_member AFTER UPDATE OF reconciliation_first_id,reconciliation_second_id ON transactions
WHEN OLD.reconciliation_first_id IS NULL AND NEW.reconciliation_first_id IS NOT NULL
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.reconciliation_first_id, NEW.reconciliation_second_id);
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.reconciliation_first_id, NEW.reconciliation_second_id);
  UPDATE dashboard_projection_state SET readiness = 'ready'
    WHERE user_id = NEW.user_id AND readiness = 'linking'
    AND (SELECT COUNT(*) FROM reconciled_transactions
      WHERE user_id = NEW.user_id AND first_transaction_id = NEW.reconciliation_first_id
        AND second_transaction_id = NEW.reconciliation_second_id) = 2;
END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_unlink_member AFTER UPDATE OF reconciliation_first_id,reconciliation_second_id ON transactions
WHEN OLD.reconciliation_first_id IS NOT NULL AND NEW.reconciliation_first_id IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transaction_reconciliation_members' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id
    AND id IN (OLD.reconciliation_first_id, OLD.reconciliation_second_id);
  INSERT INTO dashboard_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at, created_at, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at, created_at, revision
    FROM dashboard_effective_source WHERE user_id = OLD.user_id
      AND id IN (OLD.reconciliation_first_id, OLD.reconciliation_second_id);
  UPDATE dashboard_projection_state SET readiness = 'ready'
    WHERE user_id = OLD.user_id AND readiness = 'linking'
    AND NOT EXISTS (SELECT 1 FROM reconciled_transactions
      WHERE user_id = OLD.user_id AND first_transaction_id = OLD.reconciliation_first_id
        AND second_transaction_id = OLD.reconciliation_second_id);
END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_immutable_identity BEFORE UPDATE ON billing_provider_transactions WHEN NEW.transaction_id IS NOT OLD.transaction_id OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id AND NOT(NEW.attempt_id IS NULL AND NEW.attempt_id IS NULL)) BEGIN SELECT RAISE(ABORT,'billing_evidence_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_approval_monotonic BEFORE UPDATE ON billing_provider_transactions WHEN OLD.status='APPROVED' AND NEW.status IS NOT 'APPROVED' AND NOT(NEW.attempt_id IS NULL AND NEW.attempt_id IS NULL) BEGIN SELECT RAISE(ABORT,'billing_evidence_approval_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_reject_foreign_id BEFORE INSERT ON billing_provider_transactions
WHEN EXISTS (SELECT 1 FROM billing_provider_transactions AS e
  WHERE e.transaction_id = NEW.transaction_id AND e.attempt_id <> NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'billing_evidence_foreign_transaction'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_payment_sources_insert BEFORE INSERT ON card_enrollments WHEN NEW.payment_source_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_payment_sources_delete BEFORE DELETE ON card_enrollments WHEN OLD.payment_source_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_payment_sources_update BEFORE UPDATE ON card_enrollments WHEN (OLD.payment_source_id IS NOT NULL OR NEW.payment_source_id IS NOT NULL) AND (NEW.payment_source_id IS NOT OLD.payment_source_id OR NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.source_wompi_id IS NOT OLD.source_wompi_id OR NEW.source_billing_email IS NOT OLD.source_billing_email OR NEW.source_created_at_ms IS NOT OLD.source_created_at_ms OR NEW.source_retired_at_ms IS NOT OLD.source_retired_at_ms OR NEW.source_method IS NOT OLD.source_method) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id) OR (NEW.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_card_payment_sources_delete BEFORE DELETE ON card_enrollments
WHEN OLD.payment_source_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_payment_sources','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."payment_source_id",'user_id',OLD."user_id",'enrollment_id',OLD."id",'wompi_source_id',OLD."source_wompi_id",'billing_email',OLD."source_billing_email",'created_at_ms',OLD."source_created_at_ms",'method',OLD."source_method",'retired_at_ms',OLD."source_retired_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_card_payment_sources_update BEFORE UPDATE ON card_enrollments
WHEN OLD.payment_source_id IS NOT NULL AND NEW.payment_source_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_payment_sources','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."payment_source_id",'user_id',OLD."user_id",'enrollment_id',OLD."id",'wompi_source_id',OLD."source_wompi_id",'billing_email',OLD."source_billing_email",'created_at_ms',OLD."source_created_at_ms",'method',OLD."source_method",'retired_at_ms',OLD."source_retired_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_insert BEFORE INSERT ON transactions WHEN NEW.reconciliation_first_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_delete BEFORE DELETE ON transactions WHEN OLD.reconciliation_first_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_update BEFORE UPDATE ON transactions WHEN (OLD.reconciliation_first_id IS NOT NULL OR NEW.reconciliation_first_id IS NOT NULL) AND (NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.reconciliation_first_id IS NOT OLD.reconciliation_first_id OR NEW.reconciliation_second_id IS NOT OLD.reconciliation_second_id) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id) OR (NEW.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_transaction_reconciliation_members_delete BEFORE DELETE ON transactions
WHEN OLD.reconciliation_first_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_reconciliation_members','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'transaction_id',OLD."id",'first_transaction_id',OLD."reconciliation_first_id",'second_transaction_id',OLD."reconciliation_second_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_transaction_reconciliation_members_update BEFORE UPDATE ON transactions
WHEN OLD.reconciliation_first_id IS NOT NULL AND NEW.reconciliation_first_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_reconciliation_members','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'transaction_id',OLD."id",'first_transaction_id',OLD."reconciliation_first_id",'second_transaction_id',OLD."reconciliation_second_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_insert BEFORE INSERT ON billing_provider_transactions WHEN NEW.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_delete BEFORE DELETE ON billing_provider_transactions WHEN OLD.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_update BEFORE UPDATE ON billing_provider_transactions WHEN (OLD.event_received_at_ms IS NOT NULL OR NEW.event_received_at_ms IS NOT NULL) AND (NEW.transaction_id IS NOT OLD.transaction_id OR NEW.event_received_at_ms IS NOT OLD.event_received_at_ms OR NEW.event_signed_at IS NOT OLD.event_signed_at OR NEW.event_signed_status IS NOT OLD.event_signed_status OR NEW.event_lookup_attempts IS NOT OLD.event_lookup_attempts OR NEW.event_last_checked_at_ms IS NOT OLD.event_last_checked_at_ms OR NEW.event_resolved_at_ms IS NOT OLD.event_resolved_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_event_candidates_delete BEFORE DELETE ON billing_provider_transactions
WHEN OLD.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."event_received_at_ms",'signed_at',OLD."event_signed_at",'signed_status',OLD."event_signed_status",'lookup_attempts',OLD."event_lookup_attempts",'last_checked_at_ms',OLD."event_last_checked_at_ms",'resolved_at_ms',OLD."event_resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_event_candidates_update BEFORE UPDATE ON billing_provider_transactions
WHEN OLD.event_received_at_ms IS NOT NULL AND NEW.event_received_at_ms IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."event_received_at_ms",'signed_at',OLD."event_signed_at",'signed_status',OLD."event_signed_status",'lookup_attempts',OLD."event_lookup_attempts",'last_checked_at_ms',OLD."event_last_checked_at_ms",'resolved_at_ms',OLD."event_resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

INSERT INTO sql_assertions(scope,accepted) SELECT 'schema_upgrade',0 WHERE EXISTS(SELECT 1 FROM pragma_foreign_key_check);
--> statement-breakpoint

-- All rebuilt references passed pragma_foreign_key_check above; restore immediate enforcement.
PRAGMA defer_foreign_keys=OFF;
