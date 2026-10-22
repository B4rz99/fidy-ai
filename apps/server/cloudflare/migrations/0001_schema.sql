PRAGMA foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE forwarding_addresses (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 local_part TEXT NOT NULL UNIQUE CHECK(length(local_part) BETWEEN 24 AND 64),
 issued_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE anonymized_email_samples (
  id TEXT PRIMARY KEY NOT NULL,
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  source_format TEXT NOT NULL CHECK (source_format = 'notification-email'),
  source_provider TEXT NOT NULL CHECK (source_provider = 'cloudflare-email'),
  parser_revision TEXT NOT NULL CHECK (parser_revision = 'cloudflare-mime-v1'),
  anonymization_revision TEXT NOT NULL CHECK (anonymization_revision = 'structural-tags-v1'),
  structure TEXT NOT NULL CHECK (length(structure) BETWEEN 2 AND 256),
  policy_approved_at_ms INTEGER NOT NULL,
  retained_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE audit_retention_permits (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  cutoff_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE "audit_entries" (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 record_type TEXT NOT NULL,
 id TEXT,
 user_id TEXT,
 session_id TEXT,
 operation TEXT,
 outcome TEXT,
 occurred_at_ms INTEGER,
 pat_id TEXT,
 oauth_connection_id TEXT,
 oauth_credential_id TEXT,
 hosted_turn_id TEXT,
 attempt_id TEXT,
 transition TEXT,
 accepted_at_ms INTEGER,
 credential_session_id TEXT GENERATED ALWAYS AS (CASE WHEN record_type='session_call' AND operation GLOB 'dashboard.*' THEN NULL ELSE session_id END) VIRTUAL REFERENCES web_sessions(id),
 media_submission_id TEXT GENERATED ALWAYS AS (CASE WHEN record_type='media_admission' THEN id END) VIRTUAL REFERENCES media_submissions(id) ON DELETE CASCADE,
 UNIQUE(record_type,id), UNIQUE(attempt_id,transition),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(pat_id) REFERENCES pats(id),
 FOREIGN KEY(oauth_connection_id) REFERENCES oauth_connections(id),
 FOREIGN KEY(oauth_credential_id) REFERENCES oauth_credentials(access_id),
 FOREIGN KEY(hosted_turn_id) REFERENCES hosted_turns(id),
 FOREIGN KEY(attempt_id) REFERENCES billing_attempts(id),
 CHECK(
  (record_type='reminder_control' AND id IS NOT NULL AND json_valid(id) AND json_array_length(id)=2 AND json_extract(id,'$[0]')=user_id AND json_type(id,'$[1]')='text' AND user_id IS NOT NULL AND outcome IS NOT NULL AND session_id IS NULL AND operation IS NULL AND occurred_at_ms IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='session_call' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND ((operation IN ('transactions.createTransaction','transactions.listTransactions','transactions.getTransaction','transactions.updateTransaction','transactions.deleteTransaction','transactions.searchTransactions','transactions.linkTransactions','transactions.unlinkTransactions','operations.executeAtomicBatch') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('categories.listCategories','categories.listKeywordRules','categories.createKeywordRule','categories.updateKeywordRule','categories.deleteKeywordRule') AND outcome IN ('success','validation_failed'))
 OR (operation IN ('memory.remember','memory.recall','memory.revise','memory.forget') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','budgets.listBudgets','budgets.getBudget','budgets.getBudgetStatus') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('dashboard.getDashboard','dashboard.getDashboardView','dashboard.listDashboardCatalog','dashboard.applyDashboardEdit','dashboard.initializeDashboard') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('emailAuthentication.requestEmailReplacement','emailAuthentication.completeEmailReplacement') AND outcome IN ('accepted','rejected','replaced'))) AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='credential_call' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (outcome IN ('accepted','rejected')) AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='insight_call' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation IN ('insights.listPendingInsights',
    'insights.markInsightDelivered', 'insights.markInsightRead', 'insights.dismissInsight',
    'insights.getReminderSchedule', 'insights.updateReminderSchedule', 'insights.getRecurringDigestReport')) AND (outcome IN ('accepted', 'rejected')) AND ((session_id IS NOT NULL) <> (hosted_turn_id IS NOT NULL)) AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='publication' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation IN ('ingestion.submitForExtraction','ingestion.getStatementSubmission',
    'ingestion.enableEmailForwarding','ingestion.getEmailForwarding','ingestion.listNeedsReviewItems',
    'ingestion.resolveNeedsReviewItem','ingestion.skipNeedsReviewItem','ingestion.abandonStatementSubmission')) AND (outcome IN ('success','not_found','validation_failed','resource_limit')) AND (occurred_at_ms >= 0) AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='media_admission' AND user_id IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (outcome = 'accepted') AND session_id IS NULL AND operation IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='billing_transition' AND attempt_id IS NOT NULL AND transition IS NOT NULL AND occurred_at_ms IS NOT NULL AND (transition IN ('succeeded', 'failed')) AND id IS NULL AND user_id IS NULL AND session_id IS NULL AND operation IS NULL AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='request_admission' AND id IS NOT NULL AND user_id IS NOT NULL AND pat_id IS NOT NULL AND operation IS NOT NULL AND accepted_at_ms IS NOT NULL AND session_id IS NULL AND outcome IS NULL AND occurred_at_ms IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL) OR
  (record_type='identity_read' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND occurred_at_ms IS NOT NULL AND operation IS NULL AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='security_mutation' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND operation IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation = 'recovery.rotateBackupRecoveryCode') AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL)
 )
) STRICT;
--> statement-breakpoint

CREATE TABLE subscriptions (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
 current_paid_attempt_id TEXT,
 FOREIGN KEY(current_paid_attempt_id,id) REFERENCES billing_attempts(paid_attempt_id,subscription_id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(id,user_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE payment_enrollments (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
 price_id TEXT NOT NULL REFERENCES subscription_prices(id),
 billing_email TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('preparing','prepared','creating','verifying','available','refused','expired')),
 payment_source_mode TEXT NOT NULL CHECK(payment_source_mode IN('create','reuse')),
 contracts_json TEXT NOT NULL,
 disclosure_json TEXT NOT NULL,
 prepared_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms=prepared_at_ms+900000),
 accepted_at_ms INTEGER,
 payment_request_id TEXT CHECK(payment_request_id IS NULL OR length(payment_request_id)=36),
 wompi_candidate_source_id INTEGER CHECK(wompi_candidate_source_id IS NULL OR wompi_candidate_source_id>0),
 verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK(verification_attempts BETWEEN 0 AND 8),
 last_verification_at_ms INTEGER,
 refusal_reason TEXT CHECK(refusal_reason IN('provider-declined','provider-error','terms-changed')),
 method TEXT NOT NULL DEFAULT 'card' CHECK(method IN('card','nequi','daviplata')),
 wompi_environment TEXT CHECK(wompi_environment IN('sandbox','production')),
 authorization_digest TEXT CHECK(authorization_digest IS NULL OR length(authorization_digest)=64),
 payment_source_id TEXT,
 UNIQUE(id,subscription_id),
 UNIQUE(wompi_environment,wompi_candidate_source_id),
 FOREIGN KEY(payment_source_id,subscription_id) REFERENCES payment_sources(id,subscription_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(status<>'prepared' OR (payment_request_id IS NULL AND accepted_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE payment_sources (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
 subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
 origin_enrollment_id TEXT NOT NULL UNIQUE,
 wompi_environment TEXT NOT NULL CHECK(wompi_environment IN('sandbox','production')),
 wompi_source_id INTEGER NOT NULL CHECK(wompi_source_id>0),
 billing_email TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN('card','nequi','daviplata')),
 verified_at_ms INTEGER NOT NULL,
 retired_at_ms INTEGER CHECK(retired_at_ms IS NULL OR retired_at_ms>0),
 archive_row_ref TEXT NOT NULL UNIQUE,
 UNIQUE(id,subscription_id),
 UNIQUE(wompi_environment,wompi_source_id),
 FOREIGN KEY(origin_enrollment_id,subscription_id) REFERENCES payment_enrollments(id,subscription_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
--> statement-breakpoint

CREATE VIEW payment_enrollment_context AS SELECT e.rowid,e.*,s.user_id FROM payment_enrollments e JOIN subscriptions s ON s.id=e.subscription_id;
--> statement-breakpoint

CREATE VIEW payment_source_context AS SELECT p.archive_row_ref AS rowid,p.*,s.user_id,p.origin_enrollment_id AS enrollment_id,p.verified_at_ms AS created_at_ms FROM payment_sources p JOIN subscriptions s ON s.id=p.subscription_id;
--> statement-breakpoint

CREATE TABLE "billing_attempts" (
id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
enrollment_id TEXT NOT NULL REFERENCES payment_enrollments(id),
payment_request_id TEXT NOT NULL CHECK (length(payment_request_id) = 36),
payment_source_id TEXT NOT NULL REFERENCES payment_sources(id),
price_id TEXT NOT NULL REFERENCES subscription_prices(id),
time_zone TEXT NOT NULL,
wompi_environment TEXT NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
wompi_reference TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
created_at_ms INTEGER NOT NULL,
finalized_at_ms INTEGER,
previous_paid_attempt_id TEXT REFERENCES "billing_attempts"(paid_attempt_id),
period_starts_at_ms INTEGER,
period_ends_at_ms INTEGER,
calendar_anchor_ms INTEGER,
renewal_attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (renewal_attempt_number BETWEEN 1 AND 3),
paid_starts_at_ms INTEGER,
paid_ends_at_ms INTEGER,
paid_renewal_anchor_ms INTEGER,
checkout_transaction_id TEXT UNIQUE REFERENCES billing_provider_transactions(transaction_id),
collection_state TEXT DEFAULT 'armed',
collection_sent_at_ms INTEGER,
collection_last_attempt_at_ms INTEGER,
followup_due_at_ms INTEGER,
no_charge_case_id TEXT,
no_charge_operator_id TEXT,
no_charge_confirmed_at_ms INTEGER,
late_approval_observed_at_ms INTEGER,
paid_attempt_id TEXT GENERATED ALWAYS AS(CASE WHEN paid_starts_at_ms IS NOT NULL THEN id END) VIRTUAL UNIQUE,
UNIQUE(wompi_environment,wompi_reference),
UNIQUE (subscription_id, payment_request_id),
UNIQUE(id,subscription_id),
UNIQUE(paid_attempt_id,subscription_id),
FOREIGN KEY(enrollment_id,subscription_id) REFERENCES payment_enrollments(id,subscription_id),
FOREIGN KEY(payment_source_id,subscription_id) REFERENCES payment_sources(id,subscription_id),
FOREIGN KEY(previous_paid_attempt_id,subscription_id) REFERENCES billing_attempts(paid_attempt_id,subscription_id),
CHECK((paid_starts_at_ms IS NULL AND paid_starts_at_ms IS NULL AND paid_ends_at_ms IS NULL AND paid_renewal_anchor_ms IS NULL) OR (paid_starts_at_ms IS NOT NULL AND paid_starts_at_ms IS NOT NULL AND paid_ends_at_ms IS NOT NULL AND (paid_ends_at_ms > paid_starts_at_ms) AND paid_renewal_anchor_ms IS NOT NULL)),
CHECK((checkout_transaction_id IS NULL AND checkout_transaction_id IS NULL) OR (checkout_transaction_id IS NOT NULL AND checkout_transaction_id IS NOT NULL)),
CHECK((collection_state IS NULL AND collection_state IS NULL AND collection_sent_at_ms IS NULL AND collection_last_attempt_at_ms IS NULL) OR (collection_state IS NOT NULL AND collection_state IS NOT NULL AND (collection_state IN ('armed','sent','rejected')))),
CHECK((no_charge_confirmed_at_ms IS NULL AND no_charge_case_id IS NULL AND no_charge_operator_id IS NULL AND no_charge_confirmed_at_ms IS NULL) OR (no_charge_confirmed_at_ms IS NOT NULL AND no_charge_case_id IS NOT NULL AND (length(trim(no_charge_case_id)) BETWEEN 1 AND 128) AND no_charge_operator_id IS NOT NULL AND (length(trim(no_charge_operator_id)) BETWEEN 1 AND 128) AND no_charge_confirmed_at_ms IS NOT NULL AND (no_charge_confirmed_at_ms > 0))),
CHECK(late_approval_observed_at_ms IS NULL OR no_charge_confirmed_at_ms IS NOT NULL)) STRICT;
--> statement-breakpoint

CREATE TABLE billing_price_notices (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  price_id TEXT NOT NULL REFERENCES subscription_prices(id),
  created_at_ms INTEGER NOT NULL,
  last_offered_at_ms INTEGER,
  send_started_at_ms INTEGER,
  provider_accepted_at_ms INTEGER,
  PRIMARY KEY (subscription_id, price_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE billing_provider_transactions (
 transaction_id TEXT PRIMARY KEY NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 128),
 attempt_id TEXT REFERENCES billing_attempts(id),
 lookup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(lookup_attempts>=0),last_checked_at_ms INTEGER,
 status TEXT CHECK(status IN ('PENDING','APPROVED','DECLINED','VOIDED','ERROR')),
 first_observed_at_ms INTEGER,negative_observed_at_ms INTEGER,finalized_at_ms INTEGER,
 evidence_transaction_id TEXT GENERATED ALWAYS AS(CASE WHEN status IS NOT NULL THEN transaction_id END) VIRTUAL UNIQUE,
event_row_ref TEXT,event_received_at_ms INTEGER,event_signed_at INTEGER,event_signed_status TEXT,
 event_lookup_attempts INTEGER CHECK(event_lookup_attempts>=0),event_last_checked_at_ms INTEGER,event_resolved_at_ms INTEGER,
 CHECK(attempt_id IS NOT NULL OR event_received_at_ms IS NOT NULL),
 CHECK(attempt_id IS NOT NULL OR (status IS NULL AND first_observed_at_ms IS NULL AND negative_observed_at_ms IS NULL AND finalized_at_ms IS NULL)),
 CHECK((event_received_at_ms IS NULL AND event_row_ref IS NULL AND event_signed_at IS NULL AND event_signed_status IS NULL AND event_lookup_attempts IS NULL AND event_last_checked_at_ms IS NULL AND event_resolved_at_ms IS NULL)
 OR (event_received_at_ms IS NOT NULL AND event_signed_at IS NOT NULL AND event_signed_status IS NOT NULL AND event_lookup_attempts IS NOT NULL)),
 CHECK((status IS NULL AND first_observed_at_ms IS NULL AND negative_observed_at_ms IS NULL AND finalized_at_ms IS NULL)
  OR (status IS NOT NULL AND first_observed_at_ms IS NOT NULL AND (status<>'APPROVED' OR finalized_at_ms IS NOT NULL)))
) STRICT;
--> statement-breakpoint

CREATE TABLE browser_login_pairings (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  public_code TEXT NOT NULL UNIQUE CHECK (length(public_code) = 9),
  verifier_digest BLOB NOT NULL CHECK (length(verifier_digest) = 32),
  user_id TEXT REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval', 'ready', 'consumed', 'invalidated')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 5),
  last_poll_at_ms INTEGER,
  minimum_poll_interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_poll_interval_seconds BETWEEN 5 AND 60), approval_portfolio_id TEXT, approval_message_id TEXT, approval_user_id TEXT REFERENCES users(id), email_work_id TEXT, email_user_id TEXT REFERENCES users(id), email_address TEXT, email_credential_verified_at_ms INTEGER, email_state TEXT, email_public_code TEXT, email_proof_digest BLOB, email_proof_expires_at_ms INTEGER, email_expires_at_ms INTEGER, email_generation INTEGER, email_wrong_attempts INTEGER, email_last_requested_at_ms INTEGER, email_dispatch_attempted_at_ms INTEGER CHECK((approval_message_id IS NULL AND approval_portfolio_id IS NULL AND approval_message_id IS NULL AND approval_user_id IS NULL) OR (approval_message_id IS NOT NULL AND approval_portfolio_id IS NOT NULL AND approval_message_id IS NOT NULL AND approval_user_id IS NOT NULL)) CHECK((email_work_id IS NULL AND email_work_id IS NULL AND email_user_id IS NULL AND email_address IS NULL AND email_credential_verified_at_ms IS NULL AND email_state IS NULL AND email_public_code IS NULL AND email_proof_digest IS NULL AND email_proof_expires_at_ms IS NULL AND email_expires_at_ms IS NULL AND email_generation IS NULL AND email_wrong_attempts IS NULL AND email_last_requested_at_ms IS NULL AND email_dispatch_attempted_at_ms IS NULL) OR (email_work_id IS NOT NULL AND email_work_id IS NOT NULL AND (length(email_work_id) = 36) AND email_user_id IS NOT NULL AND email_address IS NOT NULL AND email_credential_verified_at_ms IS NOT NULL AND email_state IS NOT NULL AND (email_state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous', 'approved')) AND (email_public_code IS NULL OR length(email_public_code) = 9) AND (email_proof_digest IS NULL OR length(email_proof_digest) = 32) AND email_expires_at_ms IS NOT NULL AND email_generation IS NOT NULL AND (email_generation BETWEEN 1 AND 5) AND email_wrong_attempts IS NOT NULL AND (email_wrong_attempts BETWEEN 0 AND 5) AND email_last_requested_at_ms IS NOT NULL AND ((email_state IN ('sending', 'awaiting_proof') AND email_public_code IS NOT NULL AND email_proof_digest IS NOT NULL AND email_proof_expires_at_ms IS NOT NULL) OR
    (email_state NOT IN ('sending', 'awaiting_proof') AND email_public_code IS NULL AND email_proof_digest IS NULL AND email_proof_expires_at_ms IS NULL)))),
  CHECK ((state = 'pending_approval' AND user_id IS NULL) OR state <> 'pending_approval'),
  CHECK ((state = 'ready' OR state = 'consumed') = (user_id IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE budget_month_latches (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  from_utc TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  reached_80 INTEGER NOT NULL DEFAULT 0 CHECK(reached_80 IN (0, 1)),
  reached_100 INTEGER NOT NULL DEFAULT 0 CHECK(reached_100 IN (0, 1)),
  PRIMARY KEY(user_id, budget_id, from_utc, time_zone),
  FOREIGN KEY(user_id, budget_id) REFERENCES budgets(user_id, id) ON DELETE CASCADE,
  CHECK(reached_100 = 0 OR reached_80 = 1)
) STRICT;
--> statement-breakpoint

CREATE TABLE budget_month_plan_records (
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
) STRICT;
--> statement-breakpoint

CREATE TABLE "budget_state" (
 kind TEXT NOT NULL CHECK(kind IN ('user','work','publication')),user_id TEXT NOT NULL REFERENCES users(id),occurred_at TEXT NOT NULL DEFAULT '',
 record_id TEXT NOT NULL DEFAULT '',detected_at_ms INTEGER,materialized_at_ms INTEGER,
 revision INTEGER CHECK(revision>=1),budget_id TEXT,created_at_ms INTEGER,offer_requested_at_ms INTEGER,first_last_evaluated_at_ms INTEGER,
 version INTEGER DEFAULT 1,last_evaluated_at_ms INTEGER DEFAULT 0,
 PRIMARY KEY(kind,user_id,occurred_at,record_id),
 CHECK((kind='user' AND record_id='' AND detected_at_ms IS NULL AND materialized_at_ms IS NULL AND occurred_at='' AND version IS NULL AND last_evaluated_at_ms IS NULL
   AND ((budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL)
    OR(budget_id IS NOT NULL AND created_at_ms IS NOT NULL AND first_last_evaluated_at_ms IS NOT NULL) OR (kind='publication' AND occurred_at='' AND record_id<>'' AND detected_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND version IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL)))
 OR(kind='work' AND record_id='' AND detected_at_ms IS NULL AND materialized_at_ms IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL
   AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL AND version IS NOT NULL AND last_evaluated_at_ms IS NOT NULL) OR (kind='publication' AND occurred_at='' AND record_id<>'' AND detected_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND version IS NULL AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE budget_threshold_alerts (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  from_utc TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK(threshold IN (80, 100)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'delivered', 'read', 'dismissed')), crossing_json TEXT
  CHECK(crossing_json IS NULL OR json_valid(crossing_json)), delivery_group_id TEXT, consent_grant_id TEXT,
  PRIMARY KEY(user_id, budget_id, from_utc, time_zone, threshold),
  FOREIGN KEY(user_id, budget_id) REFERENCES budgets(user_id, id) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint

CREATE TABLE budgets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  currency TEXT NOT NULL,
  cap TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, group_name TEXT, starts_month TEXT,
  UNIQUE(user_id, category_id, currency),
  UNIQUE(user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "canonical_child_guard" (
  child_index INTEGER PRIMARY KEY NOT NULL CHECK (child_index BETWEEN 0 AND 11),
  accepted INTEGER NOT NULL,
  capacity_ok INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT canonical_child_guard_0 CHECK (child_index != 0 OR accepted = 1),
  CONSTRAINT canonical_child_guard_1 CHECK (child_index != 1 OR accepted = 1),
  CONSTRAINT canonical_child_guard_2 CHECK (child_index != 2 OR accepted = 1),
  CONSTRAINT canonical_child_guard_3 CHECK (child_index != 3 OR accepted = 1),
  CONSTRAINT canonical_child_guard_4 CHECK (child_index != 4 OR accepted = 1),
  CONSTRAINT canonical_child_guard_5 CHECK (child_index != 5 OR accepted = 1),
  CONSTRAINT canonical_child_guard_6 CHECK (child_index != 6 OR accepted = 1),
  CONSTRAINT canonical_child_guard_7 CHECK (child_index != 7 OR accepted = 1),
  CONSTRAINT canonical_child_guard_8 CHECK (child_index != 8 OR accepted = 1),
  CONSTRAINT canonical_child_guard_9 CHECK (child_index != 9 OR accepted = 1),
  CONSTRAINT canonical_child_guard_10 CHECK (child_index != 10 OR accepted = 1),
  CONSTRAINT canonical_child_guard_11 CHECK (child_index != 11 OR accepted = 1),
  CONSTRAINT canonical_child_capacity_0 CHECK (child_index != 0 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_1 CHECK (child_index != 1 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_2 CHECK (child_index != 2 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_3 CHECK (child_index != 3 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_4 CHECK (child_index != 4 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_5 CHECK (child_index != 5 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_6 CHECK (child_index != 6 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_7 CHECK (child_index != 7 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_8 CHECK (child_index != 8 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_9 CHECK (child_index != 9 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_10 CHECK (child_index != 10 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_11 CHECK (child_index != 11 OR capacity_ok = 1)
) STRICT;
--> statement-breakpoint

CREATE TABLE canonical_request_buckets (
  subject TEXT PRIMARY KEY NOT NULL,
  virtual_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE canonical_request_leases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE canonical_request_replays (
  user_id TEXT NOT NULL REFERENCES users(id),
  retry_key_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  identity TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','completed')),
  status INTEGER,
  body TEXT CHECK (length(CAST(body AS BLOB)) <= 1048576),
  content_type TEXT,
  PRIMARY KEY (user_id, retry_key_digest),
  CHECK ((state = 'pending' AND status IS NULL AND body IS NULL) OR (state = 'completed' AND status IS NOT NULL AND body IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0)
) STRICT;
--> statement-breakpoint

CREATE TABLE commercial_allowance_consumptions (
  user_id TEXT NOT NULL REFERENCES users(id),
  allowance TEXT NOT NULL CHECK (allowance IN ('forwarded_email','media_submission','hosted_history_turn','canonical_call')),
  identity TEXT NOT NULL CHECK (length(identity) BETWEEN 1 AND 128),
  period_start_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  units INTEGER NOT NULL CHECK (units IN (0,1)),
  PRIMARY KEY (user_id, allowance, identity)
);
--> statement-breakpoint

CREATE TABLE connection_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  public_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'invalidated')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER, prepared_session_id TEXT REFERENCES web_sessions(id) CHECK(prepared_session_id IS NULL OR status='consumed'),
  CHECK (expires_at_ms = created_at_ms + 600000),
  CHECK ((status = 'consumed' AND consumed_at_ms IS NOT NULL AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms)
    OR (status != 'consumed' AND consumed_at_ms IS NULL)),
  FOREIGN KEY (user_id, connection_id, institution_id) REFERENCES connections(user_id, id, institution_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE connection_institution_gate (
  institution_id TEXT PRIMARY KEY NOT NULL CHECK (institution_id = 'bancolombia'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
) STRICT;
--> statement-breakpoint

CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  institution_id TEXT NOT NULL REFERENCES connection_institution_gate(institution_id),
  state TEXT NOT NULL CHECK (state IN ('Connecting', 'Active', 'Action required', 'Ended')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, institution_id),
  UNIQUE (user_id, id, institution_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "consent_history" (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 record_type TEXT NOT NULL CHECK(record_type IN ('processing_grant','processing_withdrawal','processing_renewal','weekly_grant','weekly_rejection','weekly_revocation','proactivity_grant','pat_grant','pat_revocation','oauth_grant','oauth_replay_revocation','oauth_user_revocation')),
 id TEXT,
 user_id TEXT NOT NULL,
 disclosure_json TEXT,
 disclosure_message_id TEXT,
 decision_message_id TEXT,
 decision_received_at_ms INTEGER,
 grant_record_id TEXT,
 session_id TEXT,
 occurred_at_ms INTEGER,
 withdrawal_id TEXT,
 grant_id TEXT,
 offer_id TEXT,
 record_json TEXT,
 decision TEXT,
 kind TEXT,
 pairing_id TEXT,
 request_id TEXT,
 grant_consent_id TEXT,
 pat_id TEXT,
 connection_id TEXT,
 reason TEXT,
 processing_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_record_id IS NOT NULL THEN 'processing_grant' END) VIRTUAL,
 withdrawal_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN withdrawal_id IS NOT NULL THEN 'processing_withdrawal' END) VIRTUAL,
 pat_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_consent_id IS NOT NULL THEN 'pat_grant' END) VIRTUAL,
 grant_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_id IS NOT NULL THEN CASE WHEN record_type IN ('weekly_grant','weekly_revocation') THEN 'weekly_grant' WHEN record_type='proactivity_grant' THEN 'proactivity_grant' END END) VIRTUAL,
 weekly_offer_reference TEXT GENERATED ALWAYS AS (CASE WHEN record_type IN ('weekly_grant','weekly_rejection','weekly_revocation') THEN offer_id END) VIRTUAL,
 proactivity_offer_reference TEXT GENERATED ALWAYS AS (CASE WHEN record_type='proactivity_grant' THEN offer_id END) VIRTUAL,
 UNIQUE(record_type,id),
 UNIQUE(user_id,record_type,id),
 CHECK(record_type<>'processing_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND disclosure_json IS NOT NULL AND disclosure_message_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision_received_at_ms IS NOT NULL AND occurred_at_ms IS NOT NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'processing_withdrawal' OR (id IS NOT NULL AND user_id IS NOT NULL AND grant_record_id IS NOT NULL AND session_id IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'processing_renewal' OR (id IS NOT NULL AND user_id IS NOT NULL AND withdrawal_id IS NOT NULL AND grant_record_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL AND (json_valid(disclosure_json)))),
 CHECK(record_type<>'weekly_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'weekly_rejection' OR (id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND occurred_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND record_json IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL AND (decision IN ('decline','revoke')))),
 CHECK(record_type<>'weekly_revocation' OR (id IS NOT NULL AND user_id IS NOT NULL AND grant_id IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL AND (decision IN ('decline','revoke')) AND (json_valid(record_json)))),
 CHECK(record_type<>'proactivity_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND kind IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND decision IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL AND (kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')) AND (json_valid(record_json)))),
 CHECK(record_type<>'pat_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND connection_id IS NULL AND reason IS NULL AND ((pairing_id IS NULL) <> (request_id IS NULL)))),
 CHECK(record_type<>'pat_revocation' OR (id IS NOT NULL AND grant_consent_id IS NOT NULL AND user_id IS NOT NULL AND disclosure_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND request_id IS NULL AND connection_id IS NULL AND (reason IN ('pat-approved-unclaimed-expiry','pat-fixed-lifetime-expiry')) AND ((pat_id IS NULL) <> (pairing_id IS NULL)) AND ((session_id IS NULL) <> (reason IS NULL)))),
 CHECK(record_type<>'oauth_grant' OR (id IS NOT NULL AND connection_id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'oauth_replay_revocation' OR (id IS NOT NULL AND user_id IS NOT NULL AND connection_id IS NOT NULL AND reason IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND (reason = 'refresh_replay'))),
 CHECK(record_type<>'oauth_user_revocation' OR (connection_id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND reason IS NOT NULL AND disclosure_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND id IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND (reason IN ('user_one','user_all')))),
 CHECK(disclosure_json IS NULL OR json_valid(disclosure_json)),
 CHECK(record_json IS NULL OR json_valid(record_json)),
 CHECK(record_type NOT IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') OR (json_type(disclosure_json) IS 'object' AND json_type(disclosure_json,'$.revision') IS 'text' AND json_type(disclosure_json,'$.text') IS 'text' AND json_remove(disclosure_json,'$.revision','$.text')='{}')),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(session_id) REFERENCES web_sessions(id),
 FOREIGN KEY(pairing_id) REFERENCES pat_pairings(id),
 FOREIGN KEY(pat_id) REFERENCES pats(id),
 FOREIGN KEY(connection_id) REFERENCES oauth_connections(id),
 FOREIGN KEY (user_id,processing_parent_type,grant_record_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,withdrawal_parent_type,withdrawal_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,pat_parent_type,grant_consent_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,grant_parent_type,grant_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (weekly_offer_reference) REFERENCES consent_offers(weekly_offer_id),
 FOREIGN KEY (proactivity_offer_reference) REFERENCES consent_offers(proactivity_offer_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE consent_offers (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL DEFAULT 'weekly-summary' CHECK(kind IN ('weekly-summary','budget-threshold','manual-entry-reminder','new-recurring-series')),
 portfolio_id TEXT NOT NULL,bsuid TEXT NOT NULL,disclosure_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
 disclosure_message_id TEXT,disclosed_at_ms INTEGER,decision_message_id TEXT,decision TEXT CHECK(decision IN ('accept','decline','revoke')),
 source_id TEXT,rejection_id TEXT,replaces_offer_id TEXT,
 weekly_offer_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='weekly-summary' THEN id END) VIRTUAL UNIQUE,
 proactivity_offer_id TEXT GENERATED ALWAYS AS(CASE WHEN kind<>'weekly-summary' THEN id END) VIRTUAL UNIQUE,
 PRIMARY KEY(kind,id),UNIQUE(user_id,kind,id),
 CHECK((decision IS NULL)=(decision_message_id IS NULL)),
 CHECK((kind='weekly-summary' AND ((disclosure_message_id IS NULL)=(disclosed_at_ms IS NULL)) AND replaces_offer_id IS NULL)
 OR(kind<>'weekly-summary' AND json_valid(disclosure_json) AND expires_at_ms>created_at_ms AND disclosed_at_ms IS NULL AND source_id IS NULL AND rejection_id IS NULL))
) STRICT;
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

CREATE TABLE dashboard_projection_state (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version >= 0),
  readiness TEXT NOT NULL CHECK(readiness IN ('ready', 'linking', 'dirty', 'clearing-buckets', 'clearing-digits', 'clearing', 'rebuilding')),
  cursor_id TEXT NOT NULL DEFAULT '',
  attempted_at_ms INTEGER NOT NULL DEFAULT 0
, fact_revision INTEGER CHECK(fact_revision>0), first_captured_at TEXT, time_zone TEXT CHECK(
 (fact_revision IS NULL AND first_captured_at IS NULL AND time_zone IS NULL)
 OR(fact_revision IS NOT NULL AND first_captured_at IS NOT NULL AND time_zone IS NOT NULL))) STRICT;
--> statement-breakpoint

CREATE TABLE email_replacements (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  work_id TEXT NOT NULL UNIQUE CHECK (length(work_id) = 36),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  candidate_email TEXT NOT NULL CHECK (candidate_email = lower(trim(candidate_email))),
  prior_email TEXT NOT NULL,
  prior_verified_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous')),
  public_code TEXT UNIQUE CHECK (public_code IS NULL OR length(public_code) = 9),
  proof_digest BLOB CHECK (proof_digest IS NULL OR length(proof_digest) = 32),
  proof_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 5), dispatch_attempted_at_ms INTEGER,
  CHECK ((state IN ('sending', 'awaiting_proof') AND public_code IS NOT NULL AND proof_digest IS NOT NULL AND proof_expires_at_ms IS NOT NULL)
    OR (state NOT IN ('sending', 'awaiting_proof') AND public_code IS NULL AND proof_digest IS NULL AND proof_expires_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE resource_admission_counters (
  policy_key TEXT NOT NULL CHECK(policy_key IN (
    'email.pairing.user.v1','email.pairing.global.v1','email.replacement.user.v1','pat.pairing.source.v1','hosted.compaction.user.v1'
  )),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 256),
  window_kind TEXT NOT NULL CHECK((policy_key='hosted.compaction.user.v1' AND window_kind='calendar')
    OR (policy_key<>'hosted.compaction.user.v1' AND window_kind='anchored')),
  window_start_ms INTEGER NOT NULL,
  window_ends_ms INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used BETWEEN 1 AND CASE policy_key
    WHEN 'email.pairing.global.v1' THEN 1000 WHEN 'pat.pairing.source.v1' THEN 20 WHEN 'hosted.compaction.user.v1' THEN 3 ELSE 5 END),
  last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),
  owner_user_id TEXT REFERENCES users(id),
  CHECK(window_ends_ms=window_start_ms+CASE policy_key
    WHEN 'email.replacement.user.v1' THEN 86400000 WHEN 'pat.pairing.source.v1' THEN 600000 WHEN 'hosted.compaction.user.v1' THEN 86400000 ELSE 3600000 END),
  CHECK((policy_key='email.pairing.global.v1' AND scope_key='global' AND owner_user_id IS NULL)
    OR (policy_key IN ('email.pairing.user.v1','email.replacement.user.v1','hosted.compaction.user.v1')
      AND owner_user_id IS NOT NULL AND scope_key=owner_user_id)
    OR (policy_key='pat.pairing.source.v1' AND owner_user_id IS NULL
      AND length(scope_key)=64 AND scope_key NOT GLOB '*[^0-9a-f]*')),
  CHECK(policy_key<>'hosted.compaction.user.v1' OR window_start_ms%86400000=0),
  CHECK((policy_key='email.replacement.user.v1' AND last_work_id IS NOT NULL)
    OR (policy_key<>'email.replacement.user.v1' AND last_work_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_archives (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  store_id TEXT NOT NULL,
  row_ref TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body)<=1048576),
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  PRIMARY KEY(request_id,store_id,row_ref)
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_chunk (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  row_ref TEXT NOT NULL,
  PRIMARY KEY(request_id,row_ref)
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_control (
 kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('published','restore','email','statement','erasure')),
 generation TEXT,
 cursor TEXT,
 scanned INTEGER CHECK(scanned IN (0,1)),
 CHECK((kind='published' AND generation IS NOT NULL AND cursor IS NULL AND scanned IS NULL)
 OR (kind='restore' AND generation IS NOT NULL AND cursor IS NOT NULL AND scanned IS NOT NULL)
 OR (kind IN ('email','statement','erasure') AND generation IS NULL AND cursor IS NOT NULL AND scanned IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_custody_records (
 record_type TEXT NOT NULL CHECK(record_type IN ('current','event')),
 request_id TEXT NOT NULL REFERENCES erasure_requests(id),
 custodian TEXT NOT NULL,
 id TEXT,
 state TEXT,
 evidence_json TEXT CHECK(evidence_json IS NULL OR length(evidence_json)<=4096),
 recorded_at_ms INTEGER,
 operator_ref TEXT,
 current_event_id TEXT,
 event_identity TEXT GENERATED ALWAYS AS(CASE WHEN record_type='event' THEN id END) VIRTUAL UNIQUE,
 UNIQUE(request_id,custodian,event_identity),
 FOREIGN KEY(request_id,custodian,current_event_id) REFERENCES erasure_custody_records(request_id,custodian,event_identity),
 CHECK((record_type='current' AND id IS NULL AND state IS NOT NULL AND state IN ('Pending','Accepted','Verified','NotApplicable','Retained','Unresolved') AND custodian IN ('Cloudflare','Kapso','Meta','Resend','Wompi','SupportInbox','CaseRegister','CaseEvidence') AND evidence_json IS NULL AND recorded_at_ms IS NULL AND operator_ref IS NULL)
 OR(record_type='event' AND id IS NOT NULL AND state IS NULL AND evidence_json IS NOT NULL AND recorded_at_ms IS NOT NULL AND operator_ref IS NOT NULL AND current_event_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_objects (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  bucket TEXT NOT NULL CHECK(bucket IN ('email','statement')),
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  retained_key TEXT,
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  held_deleted INTEGER NOT NULL DEFAULT 0 CHECK(held_deleted IN(0,1)),
  missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  PRIMARY KEY(request_id,bucket,object_key)
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_permits (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES erasure_requests(id),
  user_id TEXT NOT NULL,
  store_id TEXT NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  case_ref TEXT UNIQUE,
  scope_ref TEXT,
  authority_ref TEXT,
  requested_at_ms INTEGER NOT NULL,
  restoring INTEGER NOT NULL DEFAULT 0 CHECK(restoring IN(0,1)),
  restore_generation TEXT,
  restore_cursor TEXT NOT NULL DEFAULT '',
  restore_objects_done INTEGER NOT NULL DEFAULT 0 CHECK(restore_objects_done IN(0,1)),
  restore_records_cursor TEXT NOT NULL DEFAULT '',
  restore_records_done INTEGER NOT NULL DEFAULT 0 CHECK(restore_records_done IN(0,1)),
  archive_generation TEXT NOT NULL DEFAULT 'initial',
  state TEXT NOT NULL CHECK(state IN ('AwaitingReview','Draining','Sealing','Archiving','Erasing','ExternalPending','Complete')),
  decision_json TEXT CHECK(decision_json IS NULL OR length(decision_json)<=16384),
  reviewed_at_ms INTEGER,
  operator_ref TEXT,
  objects_captured INTEGER NOT NULL DEFAULT 0 CHECK(objects_captured IN (0,1)),
  last_erased_at_ms INTEGER,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK(purge_pending IN(0,1)),
  purge_records_cursor TEXT NOT NULL DEFAULT '',
  last_continued_at_ms INTEGER NOT NULL DEFAULT 0,
  next_continuation_at_ms INTEGER NOT NULL DEFAULT 0,
  connection_blocked INTEGER NOT NULL DEFAULT 0 CHECK(connection_blocked IN(0,1)),
  coordinator_cleared INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_cleared IN (0,1)),
  marker_written INTEGER NOT NULL DEFAULT 0 CHECK(marker_written IN (0,1))
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_restore_members (
  generation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(generation,request_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_steps (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  store_id TEXT NOT NULL,
  data_class TEXT NOT NULL,
  archive_done INTEGER NOT NULL DEFAULT 0 CHECK(archive_done IN (0,1)),
  delete_done INTEGER NOT NULL DEFAULT 0 CHECK(delete_done IN (0,1)),
  PRIMARY KEY(request_id,store_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE erasure_writers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('email','statement')),
  object_key TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE forwarded_email_receipts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  delivery_digest TEXT NOT NULL CHECK (length(delivery_digest) = 64),
  object_key TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
  state TEXT NOT NULL CHECK (state IN ('storing', 'queued', 'expired')),
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > received_at_ms), time_zone TEXT NOT NULL DEFAULT 'America/Bogota', deferred_checked_at_ms INTEGER, outcome TEXT, outcome_transaction_id TEXT REFERENCES transactions(id), outcome_review_id TEXT, outcome_completed_at_ms INTEGER, review_id TEXT, review_reason TEXT, review_created_at_ms INTEGER, review_evidence_expires_at_ms INTEGER, dispatch_user_id TEXT REFERENCES users(id), dispatch_sent_at_ms INTEGER CHECK((dispatch_user_id IS NULL AND dispatch_user_id IS NULL AND dispatch_sent_at_ms IS NULL) OR (dispatch_user_id IS NOT NULL AND dispatch_user_id IS NOT NULL)) CHECK(dispatch_user_id IS NULL OR dispatch_user_id=user_id),
  UNIQUE (user_id, delivery_digest)
) STRICT;
--> statement-breakpoint

CREATE TABLE hosted_agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  consent_basis_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_activity_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','idle-ended','revoked')), compacted_text TEXT, compacted_through_sequence INTEGER, compacted_revision INTEGER, compacted_nonce TEXT, compacted_at_ms INTEGER CHECK((compacted_revision IS NULL AND compacted_text IS NULL AND compacted_through_sequence IS NULL AND compacted_revision IS NULL AND compacted_nonce IS NULL AND compacted_at_ms IS NULL) OR (compacted_revision IS NOT NULL AND compacted_text IS NOT NULL AND (length(compacted_text) > 0) AND compacted_through_sequence IS NOT NULL AND (compacted_through_sequence >= 0) AND compacted_revision IS NOT NULL AND (compacted_revision > 0) AND compacted_nonce IS NOT NULL AND compacted_at_ms IS NOT NULL)),
  UNIQUE (user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE hosted_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  issued_turn_id TEXT NOT NULL REFERENCES hosted_turns(id),
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  command TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_turn_id TEXT REFERENCES hosted_turns(id),
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms > issued_at_ms),
  CHECK ((consumed_turn_id IS NULL) = (consumed_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE hosted_mutation_commits (
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  PRIMARY KEY (turn_id, tool_call_id),
  FOREIGN KEY (turn_id) REFERENCES hosted_turns(id) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint

CREATE TABLE "hosted_turns" (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','interrupted')),
  failure_reason TEXT CHECK (failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed','DeliveryUnconfirmed')), proposal_receipt_digest BLOB, proposed_at_ms INTEGER, proposal_text TEXT, retention_terminal_at_ms INTEGER CHECK((proposed_at_ms IS NULL AND proposal_receipt_digest IS NULL AND proposal_text IS NULL) OR (proposed_at_ms IS NOT NULL AND proposal_receipt_digest IS NOT NULL AND (length(proposal_receipt_digest) = 32) AND proposal_text IS NOT NULL AND (length(proposal_text) > 0))), inbound_portfolio_id TEXT, inbound_bsuid TEXT, inbound_message_id TEXT, inbound_business_phone_number_id TEXT, inbound_occurred_at_ms INTEGER, inbound_received_at_ms INTEGER, inbound_reply_to_message_id TEXT, inbound_sandbox_phone TEXT, dispatch_offered_at_ms INTEGER, dispatch_created_at_ms INTEGER CHECK((inbound_portfolio_id IS NULL AND inbound_bsuid IS NULL AND inbound_message_id IS NULL AND inbound_business_phone_number_id IS NULL AND inbound_occurred_at_ms IS NULL AND inbound_received_at_ms IS NULL AND inbound_reply_to_message_id IS NULL AND inbound_sandbox_phone IS NULL AND dispatch_offered_at_ms IS NULL AND dispatch_created_at_ms IS NULL) OR (inbound_portfolio_id IS NOT NULL AND inbound_bsuid IS NOT NULL AND inbound_message_id IS NOT NULL AND inbound_business_phone_number_id IS NOT NULL AND inbound_occurred_at_ms IS NOT NULL AND inbound_received_at_ms IS NOT NULL)) CHECK(inbound_received_at_ms IS NULL OR inbound_received_at_ms>=inbound_occurred_at_ms-300000) CHECK((dispatch_created_at_ms IS NULL AND dispatch_offered_at_ms IS NULL) OR (dispatch_created_at_ms IS NOT NULL)), document_media_id TEXT CHECK(document_media_id IS NULL OR length(document_media_id) BETWEEN 1 AND 256), document_staging_id TEXT REFERENCES statement_staging_objects(id), document_upload_grant_id TEXT CHECK(document_upload_grant_id IS NULL OR length(document_upload_grant_id) BETWEEN 1 AND 128), document_upload_expires_at_ms INTEGER CHECK(document_upload_expires_at_ms IS NULL OR document_upload_expires_at_ms>=0), document_reference_json TEXT CHECK(document_reference_json IS NULL OR (json_valid(document_reference_json) AND length(document_reference_json)<=4096)), document_created_at_ms INTEGER CHECK(document_created_at_ms IS NULL OR document_created_at_ms>=0) CHECK((document_media_id IS NULL AND document_staging_id IS NULL AND document_upload_grant_id IS NULL AND document_upload_expires_at_ms IS NULL AND document_reference_json IS NULL AND document_created_at_ms IS NULL) OR (document_media_id IS NOT NULL AND document_created_at_ms IS NOT NULL)) CHECK((document_upload_grant_id IS NULL)=(document_upload_expires_at_ms IS NULL)) CHECK((document_staging_id IS NULL)=(document_reference_json IS NULL)), inbound_turn_id TEXT GENERATED ALWAYS AS(CASE WHEN inbound_message_id IS NOT NULL THEN id END) VIRTUAL,
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  UNIQUE (user_id, id),
  CHECK ((status = 'pending' AND terminal_at_ms IS NULL AND failure_reason IS NULL) OR
         (status = 'failed' AND terminal_at_ms >= started_at_ms AND failure_reason IS NOT NULL) OR
         (status IN ('completed','interrupted') AND terminal_at_ms >= started_at_ms AND failure_reason IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE hosted_whatsapp_windows (
 user_id TEXT NOT NULL, portfolio_id TEXT NOT NULL, bsuid TEXT NOT NULL,
 last_verified_inbound_at_ms INTEGER NOT NULL, closes_at_ms INTEGER NOT NULL,
 PRIMARY KEY (user_id, portfolio_id, bsuid),
 CHECK (closes_at_ms = last_verified_inbound_at_ms + 86400000)
) STRICT;
--> statement-breakpoint

CREATE TABLE ingestion_review_state (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending','skipped','created','abandoned')),
 revision INTEGER NOT NULL CHECK(revision > 0), draft_json TEXT, transaction_id TEXT,
 expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id,id), FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
 CHECK((status='created')=(transaction_id IS NOT NULL)),
 CHECK(draft_json IS NULL OR length(draft_json)<=4096)
) STRICT;
--> statement-breakpoint

CREATE TABLE "insight_events" (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version > 0),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  money_groups_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'delivered', 'read', 'dismissed')), delivery_receipt_id TEXT, delivery_sent_at TEXT, delivery_channel TEXT, delivery_provider TEXT, delivery_provider_message_id TEXT CHECK((delivery_receipt_id IS NULL AND delivery_sent_at IS NULL AND delivery_channel IS NULL AND delivery_provider IS NULL AND delivery_provider_message_id IS NULL) OR (delivery_receipt_id IS NOT NULL AND delivery_sent_at IS NOT NULL AND delivery_channel IS NOT NULL AND delivery_provider IS NOT NULL AND delivery_provider_message_id IS NOT NULL)), budget_delivery_group_id TEXT, budget_threshold INTEGER CHECK(budget_threshold IS NULL OR budget_threshold IN(80,100)), budget_crossing_json TEXT CHECK(budget_crossing_json IS NULL OR json_valid(budget_crossing_json)) CHECK((budget_delivery_group_id IS NULL AND budget_threshold IS NULL AND budget_crossing_json IS NULL) OR (budget_delivery_group_id IS NOT NULL AND budget_threshold IS NOT NULL AND budget_crossing_json IS NOT NULL)),
  report_delivery_id TEXT, transcript_id TEXT, transcript_kind TEXT CHECK(transcript_kind IS NULL OR transcript_kind='insight'), weekly_governor_counted INTEGER CHECK(weekly_governor_counted IS NULL OR (weekly_governor_counted=1 AND kind='weekly-summary')),
  CHECK((transcript_id IS NULL)=(transcript_kind IS NULL)),
  FOREIGN KEY(user_id,report_delivery_id) REFERENCES insight_reports(user_id,proactivity_reference),
  FOREIGN KEY(user_id,transcript_kind,transcript_id) REFERENCES proactive_transcript_entries(user_id,kind,id),
  UNIQUE(user_id, schedule_id, schedule_version, scheduled_at),
  UNIQUE(user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "insight_reports" (
 kind TEXT NOT NULL CHECK(kind IN ('weekly-summary','proactivity-delivery','weekly-question','offer-request')),
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 origin TEXT CHECK(origin IN ('proactive','requested')),
 request_message_id TEXT,
 rejection_offer_id TEXT,
 request_kind TEXT CHECK(request_kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')),
 materialized_at_ms INTEGER,
 last_evaluated_at_ms INTEGER,
 offer_delivery_id TEXT,
 current_recurring_opportunity INTEGER CHECK(current_recurring_opportunity IS NULL OR(current_recurring_opportunity=1 AND kind='offer-request' AND request_kind='new-recurring-series')),
 role TEXT CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT,
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER,
 expires_at_ms INTEGER,
 time_zone TEXT,
 created_at_ms INTEGER,
 payload_json TEXT CHECK(json_valid(payload_json)),
 presentation_json TEXT CHECK(json_valid(presentation_json)),
 reminder_grant_id TEXT,
 reminder_expires_at_ms INTEGER,
 instruction_id TEXT,
 instruction_version INTEGER,
 grant_id TEXT,
 local_date TEXT,
 day_from_ms INTEGER,
 day_to_ms INTEGER,
 report_json TEXT CHECK(json_valid(report_json)),
 event_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='weekly-summary' OR reminder_grant_id IS NOT NULL OR report_json IS NOT NULL THEN delivery_id END) VIRTUAL,
 dispatch_reference TEXT GENERATED ALWAYS AS (CASE WHEN scheduled_at_ms IS NOT NULL OR kind='weekly-question' THEN delivery_id END) VIRTUAL,
 proactivity_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL THEN delivery_id END) VIRTUAL,
 grant_history_type TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' THEN 'proactivity_grant' END) VIRTUAL,
 reminder_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL, dispatch_state TEXT, dispatch_created_at_ms INTEGER, dispatch_last_attempt_at_ms INTEGER, dispatch_restart_attempts INTEGER CHECK((dispatch_state IS NULL AND dispatch_created_at_ms IS NULL AND dispatch_last_attempt_at_ms IS NULL AND dispatch_restart_attempts IS NULL) OR (dispatch_state IS NOT NULL AND (dispatch_state IN ('ready','started','settled','expired','refused')) AND dispatch_created_at_ms IS NOT NULL AND dispatch_last_attempt_at_ms IS NOT NULL AND dispatch_restart_attempts IS NOT NULL AND (dispatch_restart_attempts BETWEEN 0 AND 3))) CHECK(dispatch_state IS NULL OR dispatch_reference IS NOT NULL), reminder_governor_counted INTEGER CHECK(reminder_governor_counted IS NULL OR (reminder_governor_counted=1 AND kind='proactivity-delivery')),
 PRIMARY KEY(user_id,kind,delivery_id),
 UNIQUE(user_id,kind,dispatch_reference),
 UNIQUE(user_id,proactivity_reference),
 FOREIGN KEY(user_id,event_reference) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(user_id,grant_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY(user_id,reminder_history_type,reminder_grant_id) REFERENCES consent_history(user_id,record_type,id),
 CHECK((reminder_grant_id IS NULL)=(reminder_expires_at_ms IS NULL)),
 CHECK((report_json IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL)
  OR (report_json IS NOT NULL AND instruction_id IS NOT NULL AND instruction_version IS NOT NULL AND grant_id IS NOT NULL AND local_date IS NOT NULL AND day_from_ms IS NOT NULL AND day_to_ms IS NOT NULL AND day_to_ms>day_from_ms)),
 CHECK(((kind='weekly-summary' AND consent_grant_id IS NOT NULL AND payload_json IS NOT NULL AND presentation_json IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms>scheduled_at_ms AND expires_at_ms<=scheduled_at_ms+86400000 AND role IS NULL AND offer_id IS NULL AND text IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND reminder_grant_id IS NULL AND report_json IS NULL)
  OR (kind='proactivity-delivery' AND payload_json IS NULL AND presentation_json IS NULL AND
   ((scheduled_at_ms IS NOT NULL AND role IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND created_at_ms IS NOT NULL AND
    ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL)))
   OR (scheduled_at_ms IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND (reminder_grant_id IS NOT NULL OR report_json IS NOT NULL)))))
 OR (kind='weekly-question' AND dispatch_state IS NOT NULL AND origin IS NOT NULL AND created_at_ms IS NOT NULL AND dispatch_state IN ('ready','settled','expired','refused') AND dispatch_created_at_ms=created_at_ms AND request_kind IS NULL AND materialized_at_ms IS NULL AND last_evaluated_at_ms IS NULL AND offer_delivery_id IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND scheduled_at_ms IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND payload_json IS NULL AND presentation_json IS NULL AND reminder_grant_id IS NULL AND reminder_expires_at_ms IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND report_json IS NULL)
 OR (kind='offer-request' AND request_kind IS NOT NULL AND request_message_id IS NOT NULL AND created_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND origin IS NULL AND rejection_offer_id IS NULL AND dispatch_state IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND scheduled_at_ms IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND payload_json IS NULL AND presentation_json IS NULL AND reminder_grant_id IS NULL AND reminder_expires_at_ms IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND report_json IS NULL)),
 CHECK(kind NOT IN ('weekly-summary','proactivity-delivery') OR (origin IS NULL AND request_message_id IS NULL AND rejection_offer_id IS NULL AND request_kind IS NULL AND materialized_at_ms IS NULL AND last_evaluated_at_ms IS NULL AND offer_delivery_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE keyword_rules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL CHECK (length(normalized_keyword) > 0),
  category_id TEXT NOT NULL REFERENCES categories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, normalized_keyword)
) STRICT;
--> statement-breakpoint

CREATE TABLE media_submissions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), portfolio_id TEXT NOT NULL,
 bsuid TEXT NOT NULL, message_id TEXT NOT NULL, input_digest TEXT NOT NULL, media_id TEXT, caption TEXT,
 accepted_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
 service_market TEXT NOT NULL, locale TEXT NOT NULL, time_zone TEXT NOT NULL, capacity_held INTEGER NOT NULL DEFAULT 1 CHECK(capacity_held IN (0,1)), review_reason TEXT CHECK(review_reason IN ('extraction-unavailable','unparseable-material')), review_created_at_ms INTEGER CHECK((review_reason IS NULL)=(review_created_at_ms IS NULL)),
 UNIQUE(user_id,portfolio_id,message_id), CHECK(expires_at_ms = accepted_at_ms + 2592000000)
);
--> statement-breakpoint

CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  claimed_client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource = 'https://api.fidyapp.com/mcp'),
  scopes_json TEXT NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > approved_at_ms),
  revoked_at_ms INTEGER
, refresh_allowed INTEGER NOT NULL DEFAULT 0 CHECK (refresh_allowed IN (0,1)), code_digest BLOB, code_challenge TEXT, code_expires_at_ms INTEGER, code_consumed_at_ms INTEGER CHECK((code_digest IS NULL AND code_digest IS NULL AND code_challenge IS NULL AND code_expires_at_ms IS NULL AND code_consumed_at_ms IS NULL) OR (code_digest IS NOT NULL AND code_digest IS NOT NULL AND (length(code_digest) = 32) AND code_challenge IS NOT NULL AND code_expires_at_ms IS NOT NULL))) STRICT;
--> statement-breakpoint

CREATE TABLE oauth_credentials (
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
 user_id TEXT REFERENCES users(id),digest BLOB NOT NULL CHECK(length(digest)=32),issued_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>issued_at_ms),consumed_at_ms INTEGER,
 scopes_json TEXT NOT NULL DEFAULT '["read"]',
 access_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='access' THEN id END) VIRTUAL UNIQUE,
 refresh_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='refresh' THEN id END) VIRTUAL UNIQUE,
 replacement_refresh_id TEXT UNIQUE,
 refresh_event_id TEXT UNIQUE,
 refresh_event_row_ref TEXT UNIQUE,
 UNIQUE(user_id,connection_id,refresh_id),
 FOREIGN KEY(user_id,connection_id,replacement_refresh_id) REFERENCES oauth_credentials(user_id,connection_id,refresh_id),
 CHECK(replacement_refresh_id IS NULL OR (kind='refresh' AND user_id IS NOT NULL AND consumed_at_ms IS NOT NULL AND replacement_refresh_id<>id)),
 CHECK((refresh_event_id IS NULL AND refresh_event_row_ref IS NULL) OR (refresh_event_id IS NOT NULL AND refresh_event_row_ref IS NOT NULL AND replacement_refresh_id IS NOT NULL)),
 PRIMARY KEY(kind,id),UNIQUE(kind,digest),CHECK(kind='refresh' OR(user_id IS NOT NULL AND consumed_at_ms IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE oauth_operation_intents (
  reference TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB)) <= 16384),
  input_digest BLOB NOT NULL CHECK(length(input_digest) = 32),
  binding_json TEXT NOT NULL,
  disclosure_revision TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 300000)
, browser_approved_at_ms INTEGER, browser_session_id TEXT REFERENCES web_sessions(id));
--> statement-breakpoint

CREATE TABLE oauth_public_clients (
  id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 16384),
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL
);
--> statement-breakpoint

CREATE TABLE oauth_review_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_public_clients(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL CHECK (length(request_json) <= 16384),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  user_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'cancelled')) DEFAULT 'pending'
);
--> statement-breakpoint

CREATE TABLE operational_alerts (
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  state TEXT NOT NULL CHECK (state IN ('firing', 'resolved')),
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  last_attempt_ms INTEGER,
  attempt_started_ms INTEGER,
  delivery_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (delivery_confirmed IN (0, 1)),
  next_attempt_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  acknowledged_ms INTEGER,
  PRIMARY KEY (kind, owner)
);
--> statement-breakpoint

CREATE TABLE "operational_event_buckets" (
  kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'tail_overflow', 'worker_exception', 'resource_limit', 'callback_rejection', 'workflow_failure', 'core_rejection')),
  bucket_ms INTEGER NOT NULL CHECK (bucket_ms >= 0 AND bucket_ms % 60000 = 0),
  observed_at_ms INTEGER CHECK(observed_at_ms IS NULL OR(observed_at_ms>=0 AND observed_at_ms%60000=0)),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 1000),
  CHECK((kind='core_rejection' AND bucket_ms=0 AND count=1 AND observed_at_ms IS NOT NULL) OR(kind<>'core_rejection' AND observed_at_ms IS NULL)),PRIMARY KEY (kind, bucket_ms)
) STRICT;
--> statement-breakpoint

CREATE TABLE operational_health_view (
  operation TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'attention', 'unavailable')),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0)
, last_succeeded_ms INTEGER CHECK(last_succeeded_ms IS NULL OR (last_succeeded_ms>=0 AND operation IN ('queueExecution','workflowExecution')))) STRICT;
--> statement-breakpoint

CREATE TABLE pat_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  public_code TEXT NOT NULL UNIQUE,
  proof_digest BLOB NOT NULL CHECK (length(proof_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval','approved_awaiting_claim','claimed','expired_unapproved','revoked_unclaimed')),
  user_id TEXT REFERENCES users(id),
  approved_at_ms INTEGER,
  pat_expires_at_ms INTEGER,
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 32767),
  last_poll_at_ms INTEGER,
  minimum_poll_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_poll_seconds BETWEEN 5 AND 60),
  CHECK ((state = 'pending_approval' AND user_id IS NULL AND approved_at_ms IS NULL AND pat_expires_at_ms IS NULL) OR state <> 'pending_approval'),
  CHECK ((state IN ('approved_awaiting_claim','claimed') AND user_id IS NOT NULL AND approved_at_ms IS NOT NULL AND pat_expires_at_ms IS NOT NULL AND pat_expires_at_ms = approved_at_ms + lifetime_days * 86400000) OR state NOT IN ('approved_awaiting_claim','claimed'))
) STRICT;
--> statement-breakpoint

CREATE TABLE pats (
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
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  request_id TEXT UNIQUE,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL)),
  CHECK (expires_at_ms <= created_at_ms + lifetime_days * 86400000)
) STRICT;
--> statement-breakpoint

CREATE TABLE pending_consent_exchanges (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  portfolio_id TEXT NOT NULL CHECK (length(portfolio_id) BETWEEN 1 AND 128),
  bsuid TEXT NOT NULL CHECK (length(bsuid) BETWEEN 1 AND 256),
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 32),
  initiating_message_id TEXT NOT NULL CHECK (length(initiating_message_id) BETWEEN 1 AND 256),
  initiating_body_sha256 TEXT NOT NULL CHECK (length(initiating_body_sha256) = 64),
  correlation_token TEXT NOT NULL UNIQUE CHECK (length(correlation_token) = 36),
  disclosure_json TEXT NOT NULL CHECK (length(disclosure_json) BETWEEN 1 AND 16000),
  disclosure_message_id TEXT CHECK (length(disclosure_message_id) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL,
  disclosed_at_ms INTEGER,
  decision_not_before_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision', 'accepted', 'declined')), rejected_at_ms INTEGER
  CHECK (rejected_at_ms IS NULL OR rejected_at_ms BETWEEN created_at_ms AND expires_at_ms), sandbox_phone TEXT
  CHECK (sandbox_phone IS NULL OR length(sandbox_phone) BETWEEN 8 AND 16),
  delivery_phone_number_id TEXT,
  delivery_message_id TEXT,
  delivery_occurred_at_ms INTEGER,
  delivery_received_at_ms INTEGER,
  delivery_not_before_ms INTEGER,
  decision_value TEXT,
  decision_message_id TEXT,
  decision_delivery_key TEXT,
  decision_body_sha256 TEXT,
  decision_occurred_at_ms INTEGER,
  decision_received_at_ms INTEGER,
  CHECK ((delivery_message_id IS NULL AND delivery_phone_number_id IS NULL
    AND delivery_occurred_at_ms IS NULL AND delivery_received_at_ms IS NULL AND delivery_not_before_ms IS NULL)
    OR (delivery_message_id IS NOT NULL AND delivery_phone_number_id IS NOT NULL
    AND length(delivery_phone_number_id) BETWEEN 1 AND 32 AND length(delivery_message_id) BETWEEN 1 AND 256
    AND delivery_occurred_at_ms IS NOT NULL AND delivery_received_at_ms IS NOT NULL
    AND delivery_not_before_ms IS NOT NULL AND delivery_not_before_ms >= delivery_received_at_ms)),
  CHECK ((decision_value IS NULL AND decision_message_id IS NULL AND decision_delivery_key IS NULL
    AND decision_body_sha256 IS NULL AND decision_occurred_at_ms IS NULL AND decision_received_at_ms IS NULL)
    OR (decision_value IS NOT NULL AND decision_value IN ('accepted','declined')
    AND disclosure_message_id IS NOT NULL AND decision_message_id IS NOT NULL
    AND decision_delivery_key IS NOT NULL AND length(decision_delivery_key) BETWEEN 1 AND 256
    AND decision_body_sha256 IS NOT NULL AND length(decision_body_sha256)=64
    AND decision_occurred_at_ms IS NOT NULL AND decision_received_at_ms IS NOT NULL)),
  UNIQUE (portfolio_id, initiating_message_id),
  CHECK (expires_at_ms = created_at_ms + 86400000),
  CHECK (disclosed_at_ms IS NULL OR disclosed_at_ms BETWEEN (created_at_ms / 1000) * 1000 AND expires_at_ms)
) STRICT;
--> statement-breakpoint

CREATE TABLE "proactive_transcript_entries" (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL DEFAULT 'insight' CHECK(kind IN ('insight','message')),
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 insight_event_id TEXT,
 delivery_id TEXT,
 role TEXT,
 occurred_at_ms INTEGER NOT NULL,
 text TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 UNIQUE(kind,id),
 UNIQUE(user_id,kind,id),
 UNIQUE(user_id,insight_event_id),
 UNIQUE(user_id,delivery_id),
 CHECK((kind='insight' AND insight_event_id IS NOT NULL AND delivery_id IS NULL AND role IS NULL
   AND expires_at_ms=occurred_at_ms+2592000000)
 OR (kind='message' AND insight_event_id IS NULL AND delivery_id IS NOT NULL AND role IS NOT NULL
   AND role IN ('budget-offer','reminder-offer','recurring-offer','reminder-question'))),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
--> statement-breakpoint

CREATE TABLE proactivity_governors (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder')),user_id TEXT NOT NULL REFERENCES users(id),
 unanswered INTEGER NOT NULL DEFAULT 0 CHECK(unanswered BETWEEN 0 AND 200),last_reply_at_ms INTEGER NOT NULL DEFAULT 0,
 question_needed INTEGER NOT NULL DEFAULT 0 CHECK(question_needed IN (0,1)),question_delivered INTEGER NOT NULL DEFAULT 0 CHECK(question_delivered IN (0,1)),
 question_delivered_at_ms INTEGER,question_event_id TEXT,paused_at_ms INTEGER,notice_session_id TEXT,notice_turn_id TEXT,
 notice_completed INTEGER NOT NULL DEFAULT 0 CHECK(notice_completed IN (0,1)),standing_json TEXT CHECK(standing_json IS NULL OR json_valid(standing_json)),question_id TEXT,
 PRIMARY KEY(kind,user_id),
 CHECK((kind='weekly' AND standing_json IS NULL AND question_id IS NULL AND (question_delivered=0)=(question_delivered_at_ms IS NULL) AND question_delivered<=question_needed AND (question_needed=0 OR question_event_id IS NOT NULL))
 OR(kind='reminder' AND standing_json IS NOT NULL AND unanswered=0 AND question_needed=0 AND question_delivered=0 AND question_event_id IS NULL AND paused_at_ms IS NULL AND notice_session_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE provider_authentication_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
  cookie_digest BLOB NOT NULL CHECK(length(cookie_digest) = 32),
  nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('signup','login')),
  disclosure_json TEXT,
  consent_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms <= created_at_ms + 600000),
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','verified','completed','rejected')),
  issuer TEXT,
  subject TEXT,
  contact_email TEXT,
  user_id TEXT REFERENCES users(id), provider TEXT NOT NULL DEFAULT 'google' CHECK(provider IN ('google','microsoft')), handoff_id TEXT REFERENCES whatsapp_provider_handoffs(id) ON DELETE CASCADE, completed_at_ms INTEGER, created_user INTEGER CHECK((completed_at_ms IS NULL)=(created_user IS NULL) AND (created_user IS NULL OR created_user IN (0,1))),
  CHECK((intent = 'signup') = (disclosure_json IS NOT NULL AND consent_at_ms IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE provider_credentials (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  contact_email TEXT,
  established_at_ms INTEGER NOT NULL,
  PRIMARY KEY(issuer,subject)
) STRICT;
--> statement-breakpoint

CREATE TABLE recurring_digest_items(
 user_id TEXT NOT NULL REFERENCES users(id),
 confirmation_id TEXT NOT NULL,
 confirmed_at_ms INTEGER,
 context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json)),
 item_json TEXT,
 eligible TEXT CHECK(eligible IS NULL OR eligible IN ('eligible','suppressed','invalid','legacy')),
 disposition TEXT CHECK(disposition IS NULL OR disposition IN ('included','suppressed','invalid','excluded')),
 CHECK((confirmed_at_ms IS NULL AND context_json IS NULL AND item_json IS NULL AND eligible IS NULL)
 OR(confirmed_at_ms IS NOT NULL AND context_json IS NOT NULL AND eligible IS NOT NULL)),
 CHECK(confirmed_at_ms IS NOT NULL OR disposition IS NOT NULL),
 PRIMARY KEY(user_id,confirmation_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE recurring_dispatch (id INTEGER PRIMARY KEY CHECK(id = 1), last_user TEXT NOT NULL, next_discovery_at_ms INTEGER NOT NULL DEFAULT 0) STRICT;
--> statement-breakpoint

CREATE TABLE "recurring_evaluation_records" (
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('fact','proposal','progress')),
 id TEXT NOT NULL,
 group_key TEXT,
 occurred_at TEXT,
 fact_json TEXT,
 proposal_json TEXT,
 revision INTEGER,
 phase TEXT CHECK(phase IN ('scan','detect','complete')),
 cursor_at TEXT,
 cursor_id TEXT,
 evaluated_at TEXT,
 evaluated_revision INTEGER,
 first_captured_at TEXT,
 time_zone TEXT,
 CHECK((kind='fact' AND group_key IS NOT NULL AND occurred_at IS NOT NULL AND fact_json IS NOT NULL AND proposal_json IS NULL)
 OR(kind='proposal' AND group_key IS NULL AND occurred_at IS NULL AND fact_json IS NULL AND proposal_json IS NOT NULL)
 OR(kind='progress' AND id='progress' AND group_key IS NOT NULL AND occurred_at IS NULL AND fact_json IS NULL AND proposal_json IS NULL)),
 CHECK((kind='progress' AND revision IS NOT NULL AND phase IS NOT NULL AND cursor_at IS NOT NULL AND cursor_id IS NOT NULL AND evaluated_revision IS NOT NULL AND first_captured_at IS NOT NULL AND time_zone IS NOT NULL)
 OR(kind<>'progress' AND revision IS NULL AND phase IS NULL AND cursor_at IS NULL AND cursor_id IS NULL AND evaluated_at IS NULL AND evaluated_revision IS NULL AND first_captured_at IS NULL AND time_zone IS NULL)),
 PRIMARY KEY(user_id,kind,id)
) STRICT;
--> statement-breakpoint

CREATE TABLE recurring_series (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  currency TEXT NOT NULL,
  counterparty_key TEXT NOT NULL,
  series_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0, 1)), confirmation_id TEXT, confirmed_at TEXT, confirmation_context_json TEXT, confirmation_json TEXT, digest_excluded INTEGER CHECK(digest_excluded IN(0,1)), confirmation_sequence INTEGER CHECK(
 (confirmation_id IS NULL AND confirmed_at IS NULL AND confirmation_context_json IS NULL
  AND confirmation_json IS NULL AND digest_excluded IS NULL AND confirmation_sequence IS NULL)
 OR (confirmation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmation_context_json IS NOT NULL
  AND confirmation_json IS NOT NULL AND digest_excluded IS NOT NULL AND confirmation_sequence IS NOT NULL
  AND confirmation_sequence>0)),
  PRIMARY KEY(user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "refund_attempts" (
id TEXT PRIMARY KEY CHECK (length(id) = 36),
user_id TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.userId')) VIRTUAL NOT NULL REFERENCES users(id),
billing_attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
wompi_environment TEXT NOT NULL CHECK(wompi_environment IN ('sandbox','production')),
transaction_id TEXT NOT NULL REFERENCES billing_provider_transactions(evidence_transaction_id),
request_id TEXT NOT NULL CHECK (length(request_id) = 36),
intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
treatment_json TEXT NOT NULL CHECK (json_valid(treatment_json)),
amount_in_cents INTEGER NOT NULL CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991),
kind TEXT NOT NULL CHECK (kind IN ('refund','card-void')),
operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
created_at_ms INTEGER NOT NULL,
status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
progress TEXT NOT NULL DEFAULT 'queued' CHECK (progress IN ('queued','verifying','outcome-unknown')),
finalized_at_ms INTEGER,
failure TEXT CHECK (failure IN ('provider-declined','provider-cancelled','provider-refused')),
dispatch_last_attempt_at_ms INTEGER,
verification_attempts INTEGER DEFAULT 0,
last_verification_at_ms INTEGER,
submission_claimed_at_ms INTEGER,
provider_refund_id TEXT,
verified_status TEXT,
observed_at_ms INTEGER,
access_ends_at_ms INTEGER,
renewal_stopped_at_ms INTEGER,
UNIQUE (user_id,request_id),
UNIQUE (wompi_environment,provider_refund_id),
CHECK(json_extract(intent_json,'$.billingAttemptId') IS billing_attempt_id AND json_extract(intent_json,'$.requestId') IS request_id AND json_extract(intent_json,'$.intent.kind') IS kind),
CHECK ((status='pending' AND finalized_at_ms IS NULL AND failure IS NULL)
    OR (status='succeeded' AND finalized_at_ms IS NOT NULL AND failure IS NULL)
    OR (status='failed' AND finalized_at_ms IS NOT NULL AND failure IS NOT NULL)),
CHECK((dispatch_last_attempt_at_ms IS NULL AND verification_attempts IS NULL AND last_verification_at_ms IS NULL) OR (verification_attempts IS NOT NULL AND (verification_attempts BETWEEN 0 AND 8))),
CHECK((submission_claimed_at_ms IS NULL AND submission_claimed_at_ms IS NULL) OR (submission_claimed_at_ms IS NOT NULL AND submission_claimed_at_ms IS NOT NULL)),
CHECK((verified_status IS NULL AND provider_refund_id IS NULL AND verified_status IS NULL AND observed_at_ms IS NULL) OR (verified_status IS NOT NULL AND (provider_refund_id IS NULL OR length(provider_refund_id) BETWEEN 1 AND 128) AND verified_status IS NOT NULL AND (verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED')) AND observed_at_ms IS NOT NULL)),
CHECK(access_ends_at_ms IS NULL OR (status='succeeded' AND access_ends_at_ms=observed_at_ms)),
CHECK(renewal_stopped_at_ms IS NULL OR (status='succeeded' AND renewal_stopped_at_ms=observed_at_ms))) STRICT;
--> statement-breakpoint

CREATE TABLE release_smoke_probes (
  probe_id TEXT PRIMARY KEY NOT NULL CHECK (length(probe_id) = 32),
  git_revision TEXT NOT NULL CHECK (length(git_revision) = 40),
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'passed'))
) STRICT;
--> statement-breakpoint

CREATE TABLE resource_admission_events (
  grant_id TEXT NOT NULL
    REFERENCES resource_admission_grants(id) DEFERRABLE INITIALLY DEFERRED,
  policy_key TEXT NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  dimension TEXT NOT NULL CHECK (
    dimension IN ('stable_user', 'source', 'operation', 'outstanding_work', 'spend')
  ),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  policy_kind TEXT NOT NULL CHECK (
    policy_kind IN ('rolling_window', 'calendar_window', 'outstanding')
  ),
  units INTEGER NOT NULL CHECK (units > 0),
  admitted_at_epoch_ms INTEGER NOT NULL CHECK (admitted_at_epoch_ms >= 0),
  window_start_epoch_ms INTEGER,
  expires_at_epoch_ms INTEGER NOT NULL,
  released_at_epoch_ms INTEGER,
  owner_user_id TEXT REFERENCES users(id),
  owner_session_id TEXT REFERENCES web_sessions(id),
  PRIMARY KEY (grant_id, policy_key),
  CHECK ((policy_key='pat.review.session.v1' AND owner_user_id IS NOT NULL
    AND owner_session_id IS NOT NULL AND scope_key=owner_session_id
    AND dimension='source' AND policy_kind='rolling_window' AND units=1
    AND expires_at_epoch_ms=admitted_at_epoch_ms+600000
    AND window_start_epoch_ms=max(0,admitted_at_epoch_ms-600000)
    AND released_at_epoch_ms IS NULL)
    OR (policy_key<>'pat.review.session.v1' AND owner_user_id IS NULL AND owner_session_id IS NULL)),
  CHECK (expires_at_epoch_ms > admitted_at_epoch_ms),
  CHECK (
    (policy_kind = 'outstanding' AND window_start_epoch_ms IS NULL) OR
    (policy_kind <> 'outstanding' AND window_start_epoch_ms IS NOT NULL)
  ),
  CHECK (released_at_epoch_ms IS NULL OR released_at_epoch_ms >= admitted_at_epoch_ms)
) STRICT;
--> statement-breakpoint

CREATE TABLE resource_admission_grants (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  admitted_at_epoch_ms INTEGER NOT NULL CHECK (admitted_at_epoch_ms >= 0),
  claim_count INTEGER NOT NULL CHECK (claim_count BETWEEN 1 AND 16)
) STRICT;
--> statement-breakpoint

CREATE TABLE schedule_history (
 record_type TEXT NOT NULL CHECK(record_type IN ('revision','execution','digest-day')),
 kind TEXT CHECK(kind IN ('weekly','reminder')),
 user_id TEXT NOT NULL REFERENCES users(id),
 schedule_id TEXT,
 version INTEGER,
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 scheduled_at TEXT,
 outcome TEXT,
 local_date TEXT,
 day_from_ms INTEGER,
 day_to_ms INTEGER,
 insight_event_id TEXT,
 FOREIGN KEY(user_id,kind,schedule_id) REFERENCES schedules(user_id,kind,id),
 CHECK((record_type='revision' AND kind IS NOT NULL AND schedule_id IS NOT NULL AND version>0 AND version IS NOT NULL AND snapshot_json IS NOT NULL AND scheduled_at IS NULL AND outcome IS NULL)
 OR(record_type='execution' AND kind IS NOT NULL AND schedule_id IS NOT NULL AND version IS NOT NULL AND snapshot_json IS NULL AND scheduled_at IS NOT NULL AND outcome IS NOT NULL AND (outcome IN ('generated','expired') OR(kind='weekly' AND outcome='empty')))
 OR(record_type='digest-day' AND kind IS NULL AND schedule_id IS NULL AND version IS NULL AND snapshot_json IS NULL AND scheduled_at IS NULL AND outcome IS NULL)),
 CHECK((record_type='digest-day' AND local_date IS NOT NULL AND day_from_ms IS NOT NULL AND day_to_ms IS NOT NULL)
 OR(record_type<>'digest-day' AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND insight_event_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE "schedules" (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder','digest')),
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 next_scheduled_at TEXT,
 consent_grant_id TEXT NOT NULL,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 proactivity_grant_type TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('reminder','digest') THEN 'proactivity_grant' END) VIRTUAL,
 acceptance_from_ms INTEGER,
 accepted_at_ms INTEGER,
 last_source_identity TEXT,
 next_closed_at_ms INTEGER,
 source_checkpoint TEXT,
 source_cursor TEXT,
 source_cutoff_at_ms INTEGER,
 source_complete INTEGER CHECK(source_complete IS NULL OR source_complete IN(0,1)),
 CHECK((kind='digest' AND next_scheduled_at IS NULL AND acceptance_from_ms IS NOT NULL AND accepted_at_ms IS NOT NULL)
 OR(kind<>'digest' AND next_scheduled_at IS NOT NULL AND acceptance_from_ms IS NULL AND accepted_at_ms IS NULL AND last_source_identity IS NULL AND next_closed_at_ms IS NULL AND source_checkpoint IS NULL AND source_cursor IS NULL AND source_cutoff_at_ms IS NULL AND source_complete IS NULL)),
 CHECK((source_checkpoint IS NULL AND source_cursor IS NULL AND source_cutoff_at_ms IS NULL AND source_complete IS NULL)
 OR(source_checkpoint IS NOT NULL AND source_cutoff_at_ms IS NOT NULL AND source_complete IS NOT NULL)),
 PRIMARY KEY(kind,id),
 UNIQUE(kind,user_id),
 UNIQUE(user_id,kind,id),
 FOREIGN KEY(user_id,proactivity_grant_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "source_attestations" (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'statement-line', 'notification-email')),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  interpretation_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  statement_submission_id TEXT,
  statement_record_number INTEGER,
  statement_content_hash TEXT,
  source_format TEXT,
  received_email_id TEXT,
  message_content_sha256 TEXT,
  message_evidence TEXT,
  deterministic_interpretation TEXT,
  extractor_revision TEXT, review_item_id TEXT, user_provided_fields TEXT,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (statement_submission_id) REFERENCES statement_submissions(id),
  FOREIGN KEY (user_id, received_email_id) REFERENCES forwarded_email_receipts(user_id, id),
  CHECK ((kind = 'manual' AND statement_submission_id IS NULL AND statement_record_number IS NULL
    AND statement_content_hash IS NULL AND source_format IS NULL AND received_email_id IS NULL)
    OR (kind = 'statement-line' AND statement_submission_id IS NOT NULL
      AND statement_record_number > 0 AND length(statement_content_hash) = 64
      AND source_format IN ('csv', 'xlsx') AND received_email_id IS NULL)
    OR (kind = 'notification-email' AND statement_submission_id IS NULL
      AND statement_record_number IS NULL AND statement_content_hash IS NULL
      AND received_email_id IS NOT NULL AND length(message_content_sha256) = 64
      AND message_evidence IS NOT NULL AND deterministic_interpretation IS NOT NULL
      AND extractor_revision IS NOT NULL AND source_format = 'notification-email')),
  UNIQUE (statement_submission_id, statement_record_number),
  UNIQUE (received_email_id)
) STRICT;
--> statement-breakpoint

CREATE TABLE sql_assertions (
  scope TEXT PRIMARY KEY NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
--> statement-breakpoint

CREATE TABLE statement_materializations (
 submission_id TEXT PRIMARY KEY NOT NULL REFERENCES statement_submissions(id) ON DELETE CASCADE,
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 parts_sha256 TEXT NOT NULL CHECK(length(parts_sha256)=64),
 representation_revision TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 headers_json TEXT NOT NULL CHECK(json_valid(headers_json) AND length(CAST(headers_json AS BLOB))<=524288),
 row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20000),
 part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 1024),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216),
 state TEXT NOT NULL CHECK(state IN ('building','ready'))
) STRICT;
--> statement-breakpoint

CREATE TABLE "statement_materialization_parts" (
  submission_id TEXT NOT NULL REFERENCES statement_materializations(submission_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 624),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 1023),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(submission_id,chunk_index,part_index)
) STRICT;
--> statement-breakpoint

CREATE TABLE ingestion_review_items (
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('statement','email','media')),
 email_receipt_id TEXT,
 media_submission_id TEXT,
 statement_submission_id TEXT,
 record_number INTEGER,
 reason TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 evidence_expires_at_ms INTEGER NOT NULL,
 service_market TEXT NOT NULL,
 locale TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 source_format TEXT,
 parser_revision TEXT,
 extractor_revision TEXT,
 original_evidence TEXT,
 known_money_json TEXT,
 issues_json TEXT,
 evidence_state TEXT CHECK(evidence_state IN ('retained','resolved','expired')),
 suggestions_json TEXT,
 workspace_state TEXT CHECK(workspace_state IN ('pending','skipped','created','abandoned')),
 workspace_revision INTEGER CHECK(workspace_revision>0),
 draft_json TEXT CHECK(draft_json IS NULL OR length(draft_json)<=4096),
 transaction_id TEXT,
 workspace_updated_at_ms INTEGER,
 workspace_archive_row_ref TEXT,
 PRIMARY KEY(user_id,id),
 UNIQUE(statement_submission_id,record_number),
 UNIQUE(email_receipt_id),
 UNIQUE(media_submission_id),
 FOREIGN KEY(user_id,statement_submission_id) REFERENCES statement_submissions(user_id,id),
 FOREIGN KEY(user_id,email_receipt_id) REFERENCES forwarded_email_receipts(user_id,id),
 FOREIGN KEY(user_id,media_submission_id) REFERENCES media_submissions(user_id,id),
 FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
 CHECK((source_kind='statement' AND statement_submission_id IS NOT NULL AND record_number IS NOT NULL AND record_number>0 AND email_receipt_id IS NULL AND media_submission_id IS NULL)
 OR (source_kind='email' AND email_receipt_id IS NOT NULL AND statement_submission_id IS NULL AND record_number IS NULL AND media_submission_id IS NULL)
 OR (source_kind='media' AND media_submission_id IS NOT NULL AND statement_submission_id IS NULL AND record_number IS NULL AND email_receipt_id IS NULL)),
 CHECK((source_kind='statement' AND source_format IS NOT NULL AND source_format IN ('csv','xlsx') AND parser_revision IS NOT NULL AND extractor_revision IS NOT NULL AND issues_json IS NOT NULL AND evidence_state IS NOT NULL AND ((evidence_state='retained')=(original_evidence IS NOT NULL))
 AND reason IN ('malformed-source-row','missing-required-fact','ambiguous-direction','ambiguous-currency','canonical-validation-failed','mapping-unavailable','model-unavailable'))
 OR (source_kind<>'statement' AND source_format IS NULL AND parser_revision IS NULL AND extractor_revision IS NULL AND issues_json IS NULL AND evidence_state IS NULL AND original_evidence IS NULL AND known_money_json IS NULL
 AND ((source_kind='media' AND reason IN ('extraction-unavailable','unparseable-material')) OR (source_kind='email' AND reason IN ('canonical-validation-failed','unsupported-content','unknown-format','ambiguous-format','invalid-format','provider-retrieval-failed','processing-interrupted','consent-revoked'))))),
 CHECK((workspace_state IS NULL AND workspace_revision IS NULL AND draft_json IS NULL AND transaction_id IS NULL AND workspace_updated_at_ms IS NULL AND workspace_archive_row_ref IS NULL)
 OR (workspace_state IS NOT NULL AND workspace_revision IS NOT NULL AND workspace_updated_at_ms IS NOT NULL AND workspace_archive_row_ref IS NOT NULL AND ((workspace_state='created')=(transaction_id IS NOT NULL))))
) STRICT;
--> statement-breakpoint

CREATE TABLE statement_record_outcomes (
  user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_number INTEGER NOT NULL CHECK (record_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'needs-review')),
  transaction_id TEXT,
  PRIMARY KEY (submission_id, record_number),
  FOREIGN KEY (user_id, submission_id) REFERENCES statement_submissions(user_id, id),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  CHECK ((outcome = 'accepted') = (transaction_id IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE statement_review_capacity (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  pending_count INTEGER NOT NULL CHECK (pending_count BETWEEN 0 AND 5000)
) STRICT;
--> statement-breakpoint

CREATE TABLE statement_staging_objects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Opaque R2 locator. Stored only here; it is never returned to a caller or derived from identity,
  -- filename, digest, or size, so possessing a staging reference proves nothing without ownership.
  object_key TEXT NOT NULL UNIQUE,
  -- 5242880 mirrors maximumStatementBytes in src/core/ingestion/model.ts.
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1 AND byte_length <= 5242880),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'published', 'deleting')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  -- Pointer to the submission that consumed this material, written only with the published state.
  published_submission_id TEXT, source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx')), object_deleted_at_ms INTEGER,
  CHECK ((status = 'published') = (published_submission_id IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE statement_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  staging_id TEXT NOT NULL UNIQUE REFERENCES statement_staging_objects(id),
  submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms >= 0), source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx')), parser_revision TEXT, service_market TEXT, locale TEXT, time_zone TEXT, status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'processing', 'completed', 'failed')), started_at_ms INTEGER, completed_at_ms INTEGER, input_rows INTEGER, accepted_rows INTEGER, needs_review_rows INTEGER, retention_expires_at_ms INTEGER, failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason IN ('unsupported-format', 'resource-limit',
    'malformed-file', 'mapping-unavailable', 'retention-expired')), source_parse_attempts INTEGER NOT NULL DEFAULT 0 CHECK(source_parse_attempts BETWEEN 0 AND 3), processed_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_rows>=0), processed_accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_accepted_rows>=0), processed_review_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_review_rows>=0), hosted_session_id TEXT, hosted_turn_id TEXT, hosted_expires_at_ms INTEGER, hosted_abandoned_at_ms INTEGER, clarification_state TEXT, clarification_expires_at_ms INTEGER, clarification_ended_at_ms INTEGER, work_published_at_ms INTEGER, work_last_attempt_at_ms INTEGER, work_last_reconciled_at_ms INTEGER CHECK((work_published_at_ms IS NULL AND work_last_attempt_at_ms IS NULL AND work_last_reconciled_at_ms IS NULL) OR (work_published_at_ms IS NOT NULL AND (work_published_at_ms >= 0) AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms >= 0) AND (work_last_reconciled_at_ms IS NULL OR work_last_reconciled_at_ms >= 0))),
  UNIQUE (user_id, idempotency_key)
) STRICT;
--> statement-breakpoint

CREATE TABLE subscription_prices (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'COP'),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  tax_treatment TEXT NOT NULL CHECK (tax_treatment = 'not-taxable'),
  terms_json TEXT NOT NULL,
  published_order INTEGER UNIQUE CHECK (published_order BETWEEN 1 AND 3)
) STRICT;
--> statement-breakpoint

CREATE TABLE support_recovery_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL
);
--> statement-breakpoint

CREATE TABLE support_recovery_cases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  opened_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved', 'rejected')),
  closed_at_ms INTEGER NOT NULL,
  opened_event_id TEXT,
  opened_event_row_ref TEXT,
  decision_event_id TEXT,
  decision_event_row_ref TEXT,
  CHECK (expires_at_ms > opened_at_ms),
  CHECK((opened_event_id IS NULL)=(opened_event_row_ref IS NULL)),
  CHECK((decision_event_id IS NULL)=(decision_event_row_ref IS NULL))
);
--> statement-breakpoint

CREATE TABLE transaction_corrections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  changed_fields TEXT NOT NULL,
  before_facts TEXT NOT NULL,
  after_facts TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  UNIQUE (user_id, transaction_id, previous_revision)
) STRICT;
--> statement-breakpoint

CREATE TABLE transaction_reconciliation_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  first_transaction_id TEXT NOT NULL,
  second_transaction_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('linked', 'keep-separate')),
  visible_transaction_id TEXT,
  decided_at TEXT NOT NULL,
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
) STRICT;
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
reconciliation_row_ref TEXT,reconciliation_first_id TEXT,reconciliation_second_id TEXT,
 FOREIGN KEY(user_id,reconciliation_first_id,reconciliation_second_id) REFERENCES transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id),
 CHECK((reconciliation_first_id IS NULL AND reconciliation_second_id IS NULL AND reconciliation_row_ref IS NULL) OR (reconciliation_first_id IS NOT NULL AND reconciliation_second_id IS NOT NULL AND id IN(reconciliation_first_id,reconciliation_second_id))),
 CHECK(reconciliation_first_id IS NULL OR deleted_at_ms IS NULL),
  UNIQUE (user_id, id)
) STRICT;
--> statement-breakpoint

CREATE TABLE "transcript_entries" (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','assistant','tool_call','tool_result','failed','interrupted')),
  occurred_at_ms INTEGER NOT NULL,
  text TEXT,
  failure_reason TEXT,
  iteration INTEGER,
  tool_call_id TEXT,
  operation TEXT,
  input_json TEXT,
  outcome_json TEXT,
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, id),
  CHECK ((kind IN ('user','assistant') AND text IS NOT NULL AND failure_reason IS NULL
           AND tool_call_id IS NULL AND operation IS NULL AND input_json IS NULL AND outcome_json IS NULL) OR
         (kind = 'tool_call' AND text IS NULL AND failure_reason IS NULL AND iteration BETWEEN 1 AND 32
           AND tool_call_id IS NOT NULL AND operation IS NOT NULL AND input_json IS NOT NULL AND outcome_json IS NULL) OR
         (kind = 'tool_result' AND text IS NULL AND failure_reason IS NULL AND iteration BETWEEN 1 AND 32
           AND tool_call_id IS NOT NULL AND operation IS NOT NULL AND input_json IS NULL AND outcome_json IS NOT NULL) OR
         (kind = 'failed' AND text IS NULL AND failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed','DeliveryUnconfirmed')) OR
         (kind = 'interrupted' AND text IS NULL AND failure_reason IS NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE user_documents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('dashboard','recurring-plan')),document_json TEXT NOT NULL CHECK(json_valid(document_json)),revision INTEGER NOT NULL CHECK(revision>=1),PRIMARY KEY(user_id,kind)) STRICT;
--> statement-breakpoint

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  locale TEXT NOT NULL CHECK (locale = 'es-CO'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL
, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER CHECK ((trial_started_at_ms IS NULL AND trial_ends_at_ms IS NULL) OR (trial_started_at_ms IS NOT NULL AND trial_ends_at_ms IS NOT NULL AND trial_ends_at_ms=trial_started_at_ms+604800000)), backfill_present INTEGER CHECK(backfill_present IS NULL OR backfill_present=1), backfill_submission_id TEXT REFERENCES statement_submissions(id), backfill_consumed_at_ms INTEGER CHECK(backfill_consumed_at_ms IS NULL OR backfill_consumed_at_ms>=0) CHECK(backfill_present IS NOT NULL OR (backfill_submission_id IS NULL AND backfill_consumed_at_ms IS NULL)), whatsapp_portfolio_id TEXT, whatsapp_bsuid TEXT, whatsapp_verified_at_ms INTEGER CHECK((whatsapp_portfolio_id IS NULL AND whatsapp_bsuid IS NULL AND whatsapp_verified_at_ms IS NULL) OR (whatsapp_portfolio_id IS NOT NULL AND whatsapp_bsuid IS NOT NULL AND whatsapp_verified_at_ms IS NOT NULL)), route_portfolio_id TEXT, route_bsuid TEXT, route_phone_number_id TEXT, route_verified_at_ms INTEGER CHECK((route_portfolio_id IS NULL AND route_bsuid IS NULL AND route_phone_number_id IS NULL AND route_verified_at_ms IS NULL) OR (route_portfolio_id IS NOT NULL AND route_bsuid IS NOT NULL AND route_phone_number_id IS NOT NULL AND route_verified_at_ms IS NOT NULL))) STRICT;
--> statement-breakpoint

CREATE TABLE subscription_cancellations (
  subscription_id TEXT PRIMARY KEY NOT NULL REFERENCES subscriptions(id),
  paid_attempt_id TEXT NOT NULL,
  payment_source_id TEXT NOT NULL,
  cancelled_at_ms INTEGER NOT NULL,
  paid_through_ms INTEGER NOT NULL,
  source_cancellation_state TEXT NOT NULL CHECK(source_cancellation_state IN ('detached','void-pending','voided')),
  void_started_at_ms INTEGER,
  void_verified_at_ms INTEGER,
  verification_count INTEGER NOT NULL CHECK(verification_count BETWEEN 0 AND 8),
  last_offered_at_ms INTEGER,
  FOREIGN KEY(paid_attempt_id,subscription_id) REFERENCES billing_attempts(paid_attempt_id,subscription_id),
  FOREIGN KEY(payment_source_id,subscription_id) REFERENCES payment_sources(id,subscription_id)
) STRICT;
--> statement-breakpoint

CREATE VIEW subscription_cancellation_context AS
SELECT c.rowid,s.user_id,c.subscription_id,c.paid_attempt_id,c.payment_source_id,c.cancelled_at_ms,
 c.paid_through_ms,c.source_cancellation_state AS source_cancellation,c.void_started_at_ms,
 c.void_verified_at_ms,c.verification_count,c.last_offered_at_ms
FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id;
--> statement-breakpoint

CREATE TABLE verified_email_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  address TEXT COLLATE NOCASE NOT NULL UNIQUE CHECK(address COLLATE BINARY=lower(trim(address))),
  verified_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
  created_at_ms INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL CHECK (fresh_until_ms = created_at_ms + 600000),
  idle_expires_at_ms INTEGER NOT NULL CHECK (idle_expires_at_ms >= created_at_ms AND idle_expires_at_ms <= hard_expires_at_ms),
  hard_expires_at_ms INTEGER NOT NULL CHECK (hard_expires_at_ms = created_at_ms + 7776000000),
  revoked_at_ms INTEGER
) STRICT;
--> statement-breakpoint

CREATE TABLE "whatsapp_deliveries" (
 kind TEXT NOT NULL CHECK(kind IN ('insight','proactivity','weekly-question','hosted')),
 user_id TEXT NOT NULL REFERENCES users(id),
 insight_event_id TEXT,
 correlation_token TEXT NOT NULL,
 portfolio_id TEXT,
 bsuid TEXT,
 business_phone_number_id TEXT NOT NULL,
 summary_json TEXT,
 text TEXT,
 scheduled_at_ms INTEGER,
 expires_at_ms INTEGER,
 time_zone TEXT,
 state TEXT NOT NULL DEFAULT 'ready',
 send_started_at_ms INTEGER,
 provider_message_id TEXT,
 delivered_at_ms INTEGER,
 last_received_at_ms INTEGER,
 delivery_id TEXT,
 role TEXT,
 consent_grant_id TEXT,
 template_json TEXT,
 id TEXT,
 offer_id TEXT,
 grant_id TEXT,
 created_at_ms INTEGER,
 offer_json TEXT,
 last_attempt_at_ms INTEGER DEFAULT 0,
 turn_id TEXT,
 proposed_at_ms INTEGER,
 hosted_correlation_token TEXT GENERATED ALWAYS AS(CASE WHEN kind='hosted' THEN correlation_token END) VIRTUAL UNIQUE,
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(offer_id) REFERENCES consent_offers(weekly_offer_id),
 FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, inbound_turn_id),
 CHECK(kind<>'insight' OR coalesce((user_id IS NOT NULL AND insight_event_id IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND (expires_at_ms > scheduled_at_ms AND expires_at_ms <= scheduled_at_ms + 86400000) AND ((state IN ('staged','expired')) OR send_started_at_ms IS NOT NULL) AND (state <> 'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'proactivity' OR coalesce((user_id IS NOT NULL AND delivery_id IS NOT NULL AND role IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL) OR (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','reminder-question') AND consent_grant_id IS NOT NULL)) AND (state NOT IN ('sending','accepted','ambiguous','rejected','delivered') OR send_started_at_ms IS NOT NULL) AND (state<>'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'weekly-question' OR coalesce((id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND created_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND state IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND time_zone IS NOT NULL AND last_attempt_at_ms IS NOT NULL) AND (state IN ('ready','sending','accepted','ambiguous','rejected','delivered','expired')) AND (offer_json IS NULL OR json_valid(offer_json)) AND (expires_at_ms > created_at_ms),0)),
 CHECK(kind<>'hosted' OR coalesce((turn_id IS NOT NULL AND user_id IS NOT NULL AND text IS NOT NULL AND correlation_token IS NOT NULL AND business_phone_number_id IS NOT NULL AND proposed_at_ms IS NOT NULL AND state IS NOT NULL) AND (length(text) > 0) AND (state IN ('sending','accepted','ambiguous','rejected','delivered','unconfirmed')) AND ((state = 'delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at_ms IS NULL)),0))
) STRICT;
--> statement-breakpoint

CREATE TABLE whatsapp_event_records (
 kind TEXT NOT NULL CHECK(kind IN ('voice-refusal','delivery-status')),
 portfolio_id TEXT,
 message_id TEXT,
 user_id TEXT,
 claimed_at_ms INTEGER,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('started','accepted','failed')),
 correlation_token TEXT REFERENCES whatsapp_deliveries(hosted_correlation_token),
 provider_message_id TEXT,
 status TEXT CHECK(status IS NULL OR status IN ('sent','delivered','failed')),
 occurred_at_ms INTEGER,
 received_at_ms INTEGER,
 CHECK((kind='voice-refusal' AND portfolio_id IS NOT NULL AND message_id IS NOT NULL AND user_id IS NOT NULL AND claimed_at_ms IS NOT NULL AND outcome IS NOT NULL AND correlation_token IS NULL AND provider_message_id IS NULL AND status IS NULL AND occurred_at_ms IS NULL AND received_at_ms IS NULL)
 OR(kind='delivery-status' AND portfolio_id IS NULL AND message_id IS NULL AND user_id IS NULL AND claimed_at_ms IS NULL AND outcome IS NULL AND correlation_token IS NOT NULL AND provider_message_id IS NOT NULL AND status IS NOT NULL AND occurred_at_ms IS NOT NULL AND received_at_ms IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TABLE whatsapp_provider_handoffs (
 id TEXT PRIMARY KEY NOT NULL,
 exchange_id TEXT NOT NULL REFERENCES pending_consent_exchanges(id) ON DELETE CASCADE,
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=created_at_ms AND expires_at_ms<=created_at_ms+600000),
 handoff_send_started_ms INTEGER,
 pairing_id TEXT UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
 review_code TEXT UNIQUE,
 review_started_ms INTEGER,
 review_message_id TEXT CHECK(review_message_id IS NULL OR length(review_message_id) BETWEEN 1 AND 256),
 decision TEXT CHECK(decision IN ('confirmed','denied')),
 decision_message_id TEXT CHECK(decision_message_id IS NULL OR length(decision_message_id) BETWEEN 1 AND 256),
 confirmed_at_ms INTEGER,
 consumed_at_ms INTEGER
) STRICT;
--> statement-breakpoint

CREATE INDEX audit_entries_admission_expiry ON audit_entries(accepted_at_ms) WHERE record_type='request_admission';
--> statement-breakpoint

CREATE INDEX audit_entries_history ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call');
--> statement-breakpoint

CREATE INDEX audit_entries_media ON audit_entries(media_submission_id);
--> statement-breakpoint

CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';
--> statement-breakpoint

CREATE INDEX audit_entries_pat_activity ON audit_entries(user_id,pat_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';
--> statement-breakpoint

CREATE INDEX audit_entries_retention ON audit_entries(occurred_at_ms,id,user_id) WHERE record_type IN('session_call','credential_call','insight_call','publication');
--> statement-breakpoint

CREATE INDEX audit_entries_user ON audit_entries(user_id,record_type,occurred_at_ms,id);
--> statement-breakpoint

CREATE INDEX audit_entries_user_retention ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call','publication');
--> statement-breakpoint

CREATE INDEX billing_access_by_period ON refund_attempts(billing_attempt_id,access_ends_at_ms) WHERE access_ends_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_callback_pending ON billing_provider_transactions(event_resolved_at_ms,event_received_at_ms,event_last_checked_at_ms) WHERE event_received_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX billing_callback_record_reference ON billing_provider_transactions(event_row_ref) WHERE event_row_ref IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_collection_work_due ON billing_attempts(collection_last_attempt_at_ms,id) WHERE collection_state='armed' AND collection_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_pending_health ON billing_attempts(created_at_ms) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX billing_provider_transaction_attempt ON billing_provider_transactions(attempt_id,status);
--> statement-breakpoint

CREATE UNIQUE INDEX billing_renewal_identity ON billing_attempts(previous_paid_attempt_id, renewal_attempt_number)
WHERE previous_paid_attempt_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX web_sessions_by_user ON web_sessions(user_id);
--> statement-breakpoint

CREATE INDEX browser_login_pairings_retention ON browser_login_pairings(expires_at_ms,id);
--> statement-breakpoint

CREATE UNIQUE INDEX browser_login_approvals_identity_0 ON browser_login_pairings(approval_portfolio_id,approval_message_id) WHERE approval_message_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX browser_pairing_dispatch_due ON browser_login_pairings(email_dispatch_attempted_at_ms,email_last_requested_at_ms,email_work_id) WHERE email_state='awaiting_delivery' AND email_work_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX browser_pairing_email_proofs_identity_3 ON browser_login_pairings(email_public_code) WHERE email_work_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX browser_pairing_email_proofs_identity_4 ON browser_login_pairings(email_work_id) WHERE email_work_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX budget_first_offer_due ON budget_state(first_last_evaluated_at_ms,user_id) WHERE kind='user' AND budget_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_cap_identity ON budget_month_plan_records(user_id,budget_id,month) WHERE kind='cap';
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_currency_identity ON budget_month_plan_records(user_id,group_name,month) WHERE kind='currency';
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_plan_identity ON budget_month_plan_records(user_id,month) WHERE kind='plan';
--> statement-breakpoint

CREATE INDEX budget_publication_due ON budget_state(user_id,detected_at_ms,record_id) WHERE kind='publication' AND materialized_at_ms IS NULL;
--> statement-breakpoint

CREATE INDEX budget_work_due ON budget_state(last_evaluated_at_ms,user_id,occurred_at) WHERE kind='work';
--> statement-breakpoint

CREATE INDEX budgets_by_user ON budgets(user_id, currency, category_id);
--> statement-breakpoint

CREATE INDEX cancellation_dispatch_due ON subscription_cancellations(last_offered_at_ms,subscription_id) WHERE source_cancellation_state='void-pending' AND verification_count<8;
--> statement-breakpoint

CREATE INDEX cancellation_payment_source ON subscription_cancellations(payment_source_id);
--> statement-breakpoint

CREATE INDEX canonical_request_bucket_expiry ON canonical_request_buckets(virtual_at_ms);
--> statement-breakpoint

CREATE INDEX canonical_request_global_lease_expiry ON canonical_request_leases(expires_at_ms);
--> statement-breakpoint

CREATE INDEX canonical_request_lease_expiry ON canonical_request_leases(user_id,expires_at_ms);
--> statement-breakpoint

CREATE INDEX canonical_request_replay_expiry ON canonical_request_replays(accepted_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX card_enrollment_active_user ON payment_enrollments(subscription_id)
WHERE status IN ('preparing', 'prepared', 'creating', 'verifying');
--> statement-breakpoint

CREATE UNIQUE INDEX card_enrollment_request ON payment_enrollments(subscription_id, payment_request_id)
WHERE payment_request_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX commercial_allowance_consumption_expiry ON commercial_allowance_consumptions(accepted_at_ms);
--> statement-breakpoint

CREATE INDEX commercial_allowance_period ON commercial_allowance_consumptions(user_id, allowance, period_start_ms, units);
--> statement-breakpoint

CREATE INDEX connection_attempt_expiry ON connection_attempts(user_id, expires_at_ms);
--> statement-breakpoint

CREATE INDEX connection_attempt_retention ON connection_attempts(expires_at_ms, id);
--> statement-breakpoint

CREATE UNIQUE INDEX connection_one_pending_attempt ON connection_attempts(user_id, connection_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX consent_history_active_withdrawal ON consent_history(user_id,id) WHERE record_type='processing_withdrawal';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_oauth_grant_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_oauth_replay_revocation_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_replay_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_oauth_user_revocation_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_user_revocation';
--> statement-breakpoint

CREATE INDEX consent_history_offer ON consent_history(record_type,offer_id);
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_pat_grant_unique_0 ON consent_history(request_id) WHERE record_type='pat_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_pat_grant_unique_1 ON consent_history(pairing_id) WHERE record_type='pat_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_1 ON consent_history(pairing_id) WHERE record_type='pat_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_2 ON consent_history(pat_id) WHERE record_type='pat_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_3 ON consent_history(grant_consent_id) WHERE record_type='pat_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_1 ON consent_history(user_id,kind,id) WHERE record_type='proactivity_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_2 ON consent_history(decision_message_id) WHERE record_type='proactivity_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_3 ON consent_history(grant_id) WHERE record_type='proactivity_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_processing_grant_unique_0 ON consent_history(user_id) WHERE record_type='processing_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_processing_renewal_unique_0 ON consent_history(withdrawal_id) WHERE record_type='processing_renewal';
--> statement-breakpoint

CREATE INDEX consent_history_rejection_sequence ON consent_history(user_id,sequence) WHERE record_type='weekly_rejection';
--> statement-breakpoint

CREATE INDEX consent_history_user_grant ON consent_history(user_id,record_type,kind,grant_id);
--> statement-breakpoint

CREATE INDEX consent_history_user_time ON consent_history(user_id,record_type,occurred_at_ms,sequence);
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_weekly_grant_unique_0 ON consent_history(grant_id) WHERE record_type='weekly_grant' AND ( grant_id IS NOT NULL);
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_weekly_grant_unique_2 ON consent_history(offer_id) WHERE record_type='weekly_grant';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_weekly_rejection_unique_1 ON consent_history(decision_message_id) WHERE record_type='weekly_rejection';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_weekly_revocation_unique_0 ON consent_history(decision_message_id) WHERE record_type='weekly_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_history_weekly_revocation_unique_1 ON consent_history(grant_id) WHERE record_type='weekly_revocation';
--> statement-breakpoint

CREATE UNIQUE INDEX consent_offer_decision_message ON consent_offers((kind='weekly-summary'),decision_message_id) WHERE decision_message_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX consent_offer_replacement ON consent_offers(replaces_offer_id) WHERE kind<>'weekly-summary' AND replaces_offer_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX consent_offer_weekly_disclosure ON consent_offers(disclosure_message_id) WHERE kind='weekly-summary' AND disclosure_message_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX consent_offers_user ON consent_offers(user_id,kind,created_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX custody_current_identity ON erasure_custody_records(request_id,custodian) WHERE record_type='current';
--> statement-breakpoint

CREATE INDEX dashboard_projection_due ON dashboard_projection_state(attempted_at_ms, user_id)
  WHERE readiness != 'ready' OR version != 1;
--> statement-breakpoint

CREATE INDEX dashboard_projection_leaf_budget_page ON dashboard_projection_leaf
  (user_id, category_id, currency, direction, occurred_at, id);
--> statement-breakpoint

CREATE INDEX dashboard_projection_leaf_category_recent ON dashboard_projection_leaf
  (user_id, category_id, occurred_at DESC, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX dashboard_projection_leaf_max ON dashboard_projection_leaf
  (user_id, currency, direction, category_id, length(amount) DESC, amount DESC, occurred_at);
--> statement-breakpoint

CREATE INDEX dashboard_projection_leaf_recent ON dashboard_projection_leaf
  (user_id, occurred_at DESC, created_at DESC, id DESC);
--> statement-breakpoint

CREATE UNIQUE INDEX delivery_status_identity ON whatsapp_event_records(correlation_token,provider_message_id,status,occurred_at_ms) WHERE kind='delivery-status';
--> statement-breakpoint

CREATE INDEX email_replacement_dispatch_due ON email_replacements(dispatch_attempted_at_ms,created_at_ms,work_id) WHERE state='awaiting_delivery';
--> statement-breakpoint

CREATE UNIQUE INDEX resource_counter_anchored_identity
  ON resource_admission_counters(policy_key,scope_key) WHERE window_kind='anchored';
--> statement-breakpoint

CREATE INDEX erasure_writers_by_user ON erasure_writers(user_id);
--> statement-breakpoint

CREATE INDEX forwarded_email_deferred_activation ON forwarded_email_receipts(state,deferred_checked_at_ms,id) WHERE deferred_checked_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX forwarded_email_deferred_user ON forwarded_email_receipts(user_id) WHERE deferred_checked_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX forwarded_email_outbox_pending ON forwarded_email_receipts(dispatch_sent_at_ms) WHERE dispatch_user_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX forwarded_email_receipts_capacity ON forwarded_email_receipts(state, user_id, expires_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX forwarded_email_receipts_owned ON forwarded_email_receipts(user_id, id);
--> statement-breakpoint

CREATE INDEX forwarded_email_review_by_user ON forwarded_email_receipts(user_id,review_created_at_ms DESC) WHERE review_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX forwarded_email_review_identity ON forwarded_email_receipts(review_id) WHERE review_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_agent_sessions_by_user ON hosted_agent_sessions(user_id, started_at_ms DESC);
--> statement-breakpoint

CREATE INDEX hosted_compacted_retention_due ON hosted_agent_sessions(compacted_at_ms, user_id) WHERE compacted_revision IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_compacted_retention_user ON hosted_agent_sessions(user_id, compacted_at_ms) WHERE compacted_revision IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_confirmations_one_consumption ON hosted_confirmations(consumed_turn_id)
  WHERE consumed_turn_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_confirmations_open_by_user ON hosted_confirmations(user_id, issued_at_ms DESC)
  WHERE consumed_turn_id IS NULL;
--> statement-breakpoint

CREATE INDEX hosted_confirmations_retention_due ON hosted_confirmations(expires_at_ms, user_id);
--> statement-breakpoint

CREATE INDEX hosted_confirmations_retention_user ON hosted_confirmations(user_id, expires_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_delivery_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='hosted';
--> statement-breakpoint

CREATE INDEX hosted_mutation_commits_retention_user ON hosted_mutation_commits(user_id, turn_id);
--> statement-breakpoint

CREATE INDEX hosted_turn_retention_due
  ON hosted_turns(retention_terminal_at_ms, user_id, id) WHERE retention_terminal_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_turn_retention_user
  ON hosted_turns(user_id, retention_terminal_at_ms, id) WHERE retention_terminal_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_turns_by_user_day ON hosted_turns(user_id, started_at_ms);
--> statement-breakpoint

CREATE INDEX hosted_turns_by_user_session ON hosted_turns(user_id, hosted_session_id, started_at_ms);
--> statement-breakpoint

CREATE INDEX hosted_turns_document_staging ON hosted_turns(document_staging_id) WHERE document_staging_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_turns_inbound_identity ON hosted_turns(inbound_portfolio_id,inbound_message_id) WHERE inbound_message_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_turns_inbound_turn ON hosted_turns(user_id,inbound_turn_id);
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_turns_one_pending ON hosted_turns(user_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX hosted_turns_pending_due ON hosted_turns(started_at_ms, user_id)
  WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX hosted_voice_refusals_user_window
  ON whatsapp_event_records (user_id, claimed_at_ms) WHERE kind='voice-refusal';
--> statement-breakpoint

CREATE UNIQUE INDEX hosted_whatsapp_delivery_identity ON whatsapp_deliveries(turn_id) WHERE kind='hosted';
--> statement-breakpoint

CREATE INDEX hosted_whatsapp_delivery_retention_user ON whatsapp_deliveries(user_id, turn_id) WHERE kind='hosted';
--> statement-breakpoint

CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_turns(dispatch_offered_at_ms,dispatch_created_at_ms) WHERE dispatch_created_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX hosted_whatsapp_windows_expiry ON hosted_whatsapp_windows(closes_at_ms);
--> statement-breakpoint

CREATE INDEX ingestion_review_state_expiry ON ingestion_review_state(expires_at_ms);
--> statement-breakpoint

CREATE INDEX ingestion_review_state_history ON ingestion_review_state(created_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX insight_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='insight';
--> statement-breakpoint

CREATE INDEX insight_event_report ON insight_events(user_id,report_delivery_id) WHERE report_delivery_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_event_transcript ON insight_events(user_id,transcript_kind,transcript_id) WHERE transcript_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_events_budget_occurrence ON insight_events(user_id,budget_delivery_group_id,budget_threshold) WHERE budget_delivery_group_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_events_delivery_receipt ON insight_events(delivery_receipt_id) WHERE delivery_receipt_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_events_due ON insight_events(lifecycle_state, scheduled_at, id);
--> statement-breakpoint

CREATE INDEX insight_events_pending ON insight_events(user_id, lifecycle_state, scheduled_at, id);
--> statement-breakpoint

CREATE UNIQUE INDEX insight_provider_message_identity ON whatsapp_deliveries(provider_message_id) WHERE kind='insight';
--> statement-breakpoint

CREATE UNIQUE INDEX insight_reports_proactivity_identity ON insight_reports(delivery_id) WHERE kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_reports_recurring_day ON insight_reports(user_id,local_date,day_from_ms,day_to_ms) WHERE report_json IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_reports_text_expiry ON insight_reports(created_at_ms,user_id,delivery_id) WHERE kind='proactivity-delivery' AND text IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_sent_content_retention
  ON whatsapp_deliveries(send_started_at_ms)
  WHERE kind='insight' AND (text IS NOT NULL OR summary_json IS NOT NULL);
--> statement-breakpoint

CREATE INDEX insight_staged_content_retention
  ON whatsapp_deliveries(state,expires_at_ms)
  WHERE kind='insight' AND (state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL));
--> statement-breakpoint

CREATE INDEX insight_user_sent_content_retention
  ON whatsapp_deliveries(user_id,send_started_at_ms)
  WHERE kind='insight' AND (text IS NOT NULL OR summary_json IS NOT NULL);
--> statement-breakpoint

CREATE INDEX insight_user_staged_content_retention
  ON whatsapp_deliveries(user_id,state,expires_at_ms)
  WHERE kind='insight' AND (state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL));
--> statement-breakpoint

CREATE UNIQUE INDEX insight_whatsapp_claims_identity ON whatsapp_deliveries(user_id,insight_event_id) WHERE kind='insight';
--> statement-breakpoint

CREATE INDEX insight_whatsapp_verified ON whatsapp_deliveries(state,user_id,insight_event_id) WHERE kind='insight';
--> statement-breakpoint

CREATE INDEX keyword_rules_by_user ON keyword_rules(user_id, created_at, id);
--> statement-breakpoint

CREATE INDEX media_accountability_retention ON media_submissions(accepted_at_ms,id);
--> statement-breakpoint

CREATE INDEX media_capacity_by_user ON media_submissions(user_id) WHERE capacity_held=1;
--> statement-breakpoint

CREATE INDEX media_capacity_expiry ON media_submissions(expires_at_ms,id) WHERE capacity_held=1;
--> statement-breakpoint

CREATE INDEX media_content_retention
  ON media_submissions(expires_at_ms,id)
  WHERE media_id IS NOT NULL OR caption IS NOT NULL;
--> statement-breakpoint

CREATE INDEX media_expiry ON media_submissions(expires_at_ms,id);
--> statement-breakpoint

CREATE INDEX media_review_user ON media_submissions(user_id,review_created_at_ms DESC,id DESC) WHERE review_reason IS NOT NULL;
--> statement-breakpoint

CREATE INDEX memories_by_user_creation ON memories(user_id, created_at, id);
--> statement-breakpoint

CREATE INDEX oauth_clients_unused ON oauth_public_clients(last_used_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX oauth_codes_identity_1 ON oauth_connections(code_digest) WHERE code_digest IS NOT NULL;
--> statement-breakpoint

CREATE INDEX oauth_connections_user ON oauth_connections(user_id, expires_at_ms);
--> statement-breakpoint

CREATE INDEX oauth_credentials_owner ON oauth_credentials(user_id,kind,expires_at_ms);
--> statement-breakpoint

CREATE INDEX oauth_operation_intents_expiry ON oauth_operation_intents(expires_at_ms);
--> statement-breakpoint

CREATE INDEX oauth_operation_intents_user ON oauth_operation_intents(user_id);
--> statement-breakpoint

CREATE INDEX oauth_review_expiry ON oauth_review_requests(expires_at_ms);
--> statement-breakpoint

CREATE INDEX oauth_review_source ON oauth_review_requests(source_digest, state, expires_at_ms);
--> statement-breakpoint

CREATE INDEX oauth_review_user ON oauth_review_requests(user_id, state, expires_at_ms);
--> statement-breakpoint

CREATE INDEX pairing_email_pending_health ON browser_login_pairings(email_last_requested_at_ms)
  WHERE email_state IN ('awaiting_delivery', 'sending', 'ambiguous') AND email_work_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX pairing_email_rejected_health ON browser_login_pairings(email_last_requested_at_ms) WHERE email_state = 'rejected' AND email_work_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX pat_pairings_capacity ON pat_pairings(created_at_ms);
--> statement-breakpoint

CREATE INDEX pats_user_active ON pats(user_id,revoked_at_ms,expires_at_ms);
--> statement-breakpoint

CREATE INDEX pats_user_issuance ON pats(user_id,issued_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX payment_authorization_once ON payment_enrollments(authorization_digest)
WHERE authorization_digest IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX pending_consent_decisions_identity_0 ON pending_consent_exchanges(portfolio_id,decision_message_id) WHERE decision_value IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX pending_consent_one_caller ON pending_consent_exchanges(portfolio_id, bsuid)
  WHERE state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision');
--> statement-breakpoint

CREATE INDEX proactive_transcript_retention ON proactive_transcript_entries(expires_at_ms,sequence);
--> statement-breakpoint

CREATE INDEX proactivity_channel_started ON whatsapp_deliveries(user_id,send_started_at_ms) WHERE kind='proactivity';
--> statement-breakpoint

CREATE UNIQUE INDEX proactivity_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='proactivity';
--> statement-breakpoint

CREATE INDEX proactivity_offer_requests_due ON insight_reports(materialized_at_ms,last_evaluated_at_ms,created_at_ms) WHERE kind='offer-request';
--> statement-breakpoint

CREATE UNIQUE INDEX proactivity_provider_message_identity ON whatsapp_deliveries(user_id,provider_message_id) WHERE kind='proactivity';
--> statement-breakpoint

CREATE UNIQUE INDEX proactivity_request_identity ON insight_reports(delivery_id) WHERE kind='offer-request';
--> statement-breakpoint

CREATE INDEX proactivity_sent_content_retention
  ON whatsapp_deliveries(send_started_at_ms)
  WHERE kind='proactivity' AND (text IS NOT NULL OR template_json IS NOT NULL);
--> statement-breakpoint

CREATE INDEX proactivity_staged_content_retention
  ON whatsapp_deliveries(state,expires_at_ms)
  WHERE kind='proactivity' AND (state='staged' AND (text IS NOT NULL OR template_json IS NOT NULL));
--> statement-breakpoint

CREATE UNIQUE INDEX proactivity_whatsapp_claims_identity ON whatsapp_deliveries(user_id,delivery_id) WHERE kind='proactivity';
--> statement-breakpoint

CREATE INDEX provider_attempt_expiry ON provider_authentication_attempts(expires_at_ms);
--> statement-breakpoint

CREATE INDEX reconciliation_members_by_pair ON transactions(user_id,reconciliation_first_id,reconciliation_second_id,id) WHERE reconciliation_first_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX reconciliation_record_reference ON transactions(reconciliation_row_ref) WHERE reconciliation_row_ref IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX recurring_confirmation_identity ON recurring_series(user_id,confirmation_id) WHERE confirmation_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX recurring_confirmation_order ON recurring_series(user_id,confirmed_at,confirmation_id) WHERE confirmation_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX recurring_confirmation_page ON recurring_series(user_id,confirmation_sequence) WHERE confirmation_sequence IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX recurring_confirmation_sequence ON recurring_series(confirmation_sequence) WHERE confirmation_sequence IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX recurring_current_opportunity ON insight_reports(user_id) WHERE current_recurring_opportunity=1 AND kind='offer-request';
--> statement-breakpoint

CREATE INDEX recurring_facts_by_group_typed ON recurring_evaluation_records(user_id, group_key, occurred_at, id) WHERE kind='fact';
--> statement-breakpoint

CREATE INDEX recurring_series_by_order ON recurring_series(user_id, currency, counterparty_key, id);
--> statement-breakpoint

CREATE INDEX recurring_unfinished_users ON recurring_evaluation_records(user_id) WHERE phase<>'complete' AND kind='progress';
--> statement-breakpoint

CREATE INDEX refunds_by_charge ON refund_attempts(billing_attempt_id,status);
--> statement-breakpoint

CREATE INDEX refunds_by_user ON refund_attempts(user_id,created_at_ms);
--> statement-breakpoint

CREATE INDEX release_smoke_expiry ON release_smoke_probes(expires_at_ms);
--> statement-breakpoint

CREATE INDEX reminder_delivery_receipts_marker_user ON insight_reports(user_id,delivery_id) WHERE reminder_governor_counted=1;
--> statement-breakpoint

CREATE INDEX replacement_email_pending_health ON email_replacements(created_at_ms)
  WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous');
--> statement-breakpoint

CREATE INDEX replacement_email_rejected_health ON email_replacements(created_at_ms) WHERE state = 'rejected';
--> statement-breakpoint

CREATE INDEX report_dispatch_due ON insight_reports(dispatch_state,dispatch_last_attempt_at_ms,dispatch_created_at_ms,kind,delivery_id,user_id) WHERE dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX report_dispatch_health ON insight_reports(kind,dispatch_created_at_ms,user_id,delivery_id)
 WHERE dispatch_state IN ('ready','started') AND dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX resource_admission_active_scope
  ON resource_admission_events (
    policy_key,
    dimension,
    scope_key,
    expires_at_epoch_ms,
    admitted_at_epoch_ms
  );
--> statement-breakpoint

CREATE INDEX resource_admission_ai_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'workers-ai-*';
--> statement-breakpoint

CREATE INDEX resource_admission_enrollment_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'card-preparation-attempt-*';
--> statement-breakpoint

CREATE INDEX resource_admission_grant_release
  ON resource_admission_events (grant_id, dimension, released_at_epoch_ms);
--> statement-breakpoint

CREATE INDEX resource_admission_provider_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'provider-admission-*';
--> statement-breakpoint

CREATE INDEX resource_admission_upload_retention
  ON resource_admission_grants (admitted_at_epoch_ms, id)
  WHERE id GLOB 'ingestion-upload-*';
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_digest_day ON schedule_history(user_id,local_date,day_from_ms,day_to_ms) WHERE record_type='digest-day';
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_execution ON schedule_history(user_id,kind,schedule_id,version,scheduled_at) WHERE record_type='execution';
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_revision ON schedule_history(user_id,kind,schedule_id,version) WHERE record_type='revision';
--> statement-breakpoint

CREATE UNIQUE INDEX schedules_digest_identity ON schedules(id) WHERE kind='digest';
--> statement-breakpoint

CREATE INDEX schedules_due ON schedules(kind,enabled,last_evaluated_at_ms,next_scheduled_at,id);
--> statement-breakpoint

CREATE UNIQUE INDEX source_attestation_review_item ON source_attestations(user_id,review_item_id) WHERE review_item_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX source_attestations_by_transaction ON source_attestations(user_id, transaction_id);
--> statement-breakpoint

CREATE INDEX statement_clarification_deadline ON statement_submissions(clarification_expires_at_ms) WHERE clarification_state='awaiting';
--> statement-breakpoint

CREATE INDEX statement_hosted_expiry ON statement_submissions(hosted_expires_at_ms) WHERE hosted_session_id IS NOT NULL AND hosted_abandoned_at_ms IS NULL;
--> statement-breakpoint

CREATE INDEX statement_hosted_session ON statement_submissions(user_id,hosted_session_id);
--> statement-breakpoint

CREATE INDEX statement_ingestion_outbox_attempt
  ON statement_submissions(work_last_attempt_at_ms, work_published_at_ms, id) WHERE work_published_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX statement_ingestion_outbox_reconciliation
  ON statement_submissions(work_last_reconciled_at_ms, work_published_at_ms, id) WHERE work_published_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE INDEX statement_pending_health ON statement_submissions(submitted_at_ms)
  WHERE status IN ('queued', 'processing');
--> statement-breakpoint

CREATE INDEX statement_review_expiry ON ingestion_review_items(evidence_expires_at_ms)
  WHERE source_kind='statement' AND evidence_state = 'retained';
--> statement-breakpoint

CREATE INDEX statement_staging_delete_retention
  ON statement_staging_objects(expires_at_ms,id)
  WHERE status='deleting' AND object_deleted_at_ms IS NULL;
--> statement-breakpoint

CREATE INDEX statement_staging_expiry
  ON statement_staging_objects(expires_at_ms)
  WHERE status != 'published';
--> statement-breakpoint

CREATE INDEX statement_staging_unpublished_retention
  ON statement_staging_objects(expires_at_ms,id)
  WHERE status IN ('pending','available') AND object_deleted_at_ms IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX statement_submissions_owned ON statement_submissions(user_id, id);
--> statement-breakpoint

CREATE INDEX statement_submissions_retention
  ON statement_submissions(retention_expires_at_ms)
  WHERE status IN ('queued', 'processing');
--> statement-breakpoint

CREATE INDEX statement_submissions_user_submitted
  ON statement_submissions(user_id, submitted_at_ms);
--> statement-breakpoint

CREATE INDEX support_recovery_admissions_operator ON support_recovery_admissions(operator_issuer, operator_subject, admitted_at_ms);
--> statement-breakpoint

CREATE INDEX support_recovery_admissions_time ON support_recovery_admissions(admitted_at_ms);
--> statement-breakpoint

CREATE INDEX support_recovery_cases_retention ON support_recovery_cases(closed_at_ms, id);
--> statement-breakpoint

CREATE INDEX support_recovery_cases_user ON support_recovery_cases(user_id, opened_at_ms);
--> statement-breakpoint

CREATE INDEX transactions_by_user_creation ON transactions(user_id, created_at);
--> statement-breakpoint

CREATE INDEX transactions_by_user_occurrence ON transactions(user_id, occurred_at DESC, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX transcript_entries_by_session ON transcript_entries(user_id, hosted_session_id, sequence);
--> statement-breakpoint

CREATE INDEX transcript_entries_by_turn ON transcript_entries(user_id, turn_id);
--> statement-breakpoint

CREATE UNIQUE INDEX transcript_one_terminal ON transcript_entries(turn_id) WHERE kind IN ('assistant','failed','interrupted');
--> statement-breakpoint

CREATE UNIQUE INDEX transcript_one_user ON transcript_entries(turn_id) WHERE kind = 'user';
--> statement-breakpoint

CREATE UNIQUE INDEX transcript_tool_call ON transcript_entries(turn_id, tool_call_id) WHERE kind = 'tool_call';
--> statement-breakpoint

CREATE UNIQUE INDEX transcript_tool_result ON transcript_entries(turn_id, tool_call_id) WHERE kind = 'tool_result';
--> statement-breakpoint

CREATE INDEX users_backfill_submission ON users(backfill_submission_id) WHERE backfill_submission_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX users_whatsapp_identity ON users(whatsapp_portfolio_id,whatsapp_bsuid) WHERE whatsapp_portfolio_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX voice_refusal_identity ON whatsapp_event_records(portfolio_id,message_id) WHERE kind='voice-refusal';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_consent_offer_source ON consent_offers(user_id,source_id) WHERE kind='weekly-summary' AND source_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX weekly_governor_deliveries_marker_user ON insight_events(user_id,id) WHERE weekly_governor_counted=1;
--> statement-breakpoint

CREATE INDEX weekly_governor_questions_due ON whatsapp_deliveries(state,last_attempt_at_ms,created_at_ms) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_governor_questions_identity ON whatsapp_deliveries(id) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_governor_questions_offer ON whatsapp_deliveries(user_id,offer_id) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_content_retention
  ON whatsapp_deliveries(created_at_ms,id)
  WHERE kind='weekly-question' AND (text IS NOT NULL OR offer_json IS NOT NULL);
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_identity ON insight_reports(delivery_id) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_intents_due ON insight_reports(dispatch_state,dispatch_last_attempt_at_ms,created_at_ms) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_intents_expiry ON insight_reports(dispatch_state,created_at_ms) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_intents_health ON insight_reports(created_at_ms, user_id, delivery_id)
WHERE dispatch_state='ready' AND kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_provider_identity ON whatsapp_deliveries(user_id,provider_message_id) WHERE kind='weekly-question' AND (provider_message_id IS NOT NULL);
--> statement-breakpoint

CREATE INDEX weekly_question_ready_retention
  ON whatsapp_deliveries(state,expires_at_ms,id)
  WHERE kind='weekly-question' AND (state='ready' AND (text IS NOT NULL OR offer_json IS NOT NULL));
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_request ON insight_reports(user_id,request_message_id) WHERE request_message_id IS NOT NULL AND kind='weekly-question';
--> statement-breakpoint

CREATE INDEX whatsapp_handoff_exchange ON whatsapp_provider_handoffs(exchange_id,created_at_ms);
--> statement-breakpoint

CREATE VIEW billing_callback_hints AS SELECT COALESCE(event_row_ref,'callback:'||transaction_id) AS rowid,transaction_id,event_received_at_ms AS received_at_ms,event_signed_at AS signed_at,event_signed_status AS signed_status,event_lookup_attempts AS lookup_attempts,event_last_checked_at_ms AS last_checked_at_ms,event_resolved_at_ms AS resolved_at_ms FROM billing_provider_transactions WHERE event_received_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE VIEW billing_retry_clearances AS
SELECT a.id AS attempt_id FROM billing_attempt_context a
JOIN billing_provider_transactions evidence ON evidence.attempt_id=a.id
WHERE a.status='failed' AND a.collection_state='sent'
  AND evidence.status='DECLINED' AND evidence.finalized_at_ms IS NOT NULL
  AND evidence.finalized_at_ms<=a.finalized_at_ms
  AND evidence.negative_observed_at_ms<=a.finalized_at_ms-180000
  AND (a.checkout_transaction_id IS NULL OR a.checkout_transaction_id=evidence.transaction_id)
  AND NOT EXISTS (SELECT 1 FROM billing_provider_transactions candidate
    WHERE candidate.attempt_id=a.id AND candidate.transaction_id<>evidence.transaction_id)
  AND a.paid_starts_at_ms IS NULL;
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

CREATE VIEW ingestion_review_originals AS
SELECT r.id, r.user_id, 'statement' AS source, r.reason, r.created_at_ms,
  r.evidence_expires_at_ms AS expires_at_ms, r.service_market, r.locale, r.time_zone, r.review_suggestions_json AS suggestions_json,
  'pending' AS status, NULL AS transaction_id
FROM statement_review_context r
UNION ALL
SELECT s.review_id,s.user_id,'email',s.review_reason,s.review_created_at_ms,s.review_evidence_expires_at_ms,'CO','es-CO',s.time_zone,NULL,'pending',NULL FROM forwarded_email_receipts s WHERE s.review_id IS NOT NULL
UNION ALL
SELECT s.id, s.user_id, 'media', s.review_reason, s.review_created_at_ms, s.expires_at_ms,
  s.service_market, s.locale, s.time_zone, NULL, 'pending', NULL
FROM media_submissions s WHERE s.review_reason IS NOT NULL;
--> statement-breakpoint

CREATE VIEW ingestion_review_sources AS
SELECT s.id,s.user_id,s.source,s.reason,s.created_at_ms,s.expires_at_ms,s.service_market,s.locale,s.time_zone,
  CASE WHEN d.status='abandoned' THEN 'expired' ELSE coalesce(d.status,s.status) END AS status,coalesce(d.transaction_id,s.transaction_id) AS transaction_id,
  coalesce(d.revision,0) AS revision,d.draft_json,s.suggestions_json
FROM ingestion_review_originals s LEFT JOIN ingestion_review_workspace_state d ON d.id=s.id AND d.user_id=s.user_id;
--> statement-breakpoint

CREATE VIEW ingestion_statement_review_decisions AS SELECT id AS review_id,statement_submission_id AS submission_id,user_id,CASE workspace_state WHEN 'created' THEN 'resolved' ELSE workspace_state END AS decision,transaction_id,workspace_updated_at_ms AS decided_at_ms FROM ingestion_review_items WHERE source_kind='statement' AND workspace_state!='pending';
--> statement-breakpoint

CREATE VIEW proactivity_delivery_metadata AS
 SELECT user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,
 dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts,CASE WHEN kind='weekly-question' THEN created_at_ms+86400000 ELSE expires_at_ms END AS expires_at_ms,
 (kind IN ('weekly-summary','weekly-question') OR text IS NOT NULL) AS content_available
 FROM insight_reports WHERE dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE VIEW reconciled_transactions AS SELECT COALESCE(reconciliation_row_ref,'member:'||id) AS rowid,user_id,id AS transaction_id,reconciliation_first_id AS first_transaction_id,reconciliation_second_id AS second_transaction_id FROM transactions WHERE reconciliation_first_id IS NOT NULL;
--> statement-breakpoint

CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM (SELECT rowid,id AS refund_id,user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM subscription_cancellation_context;
--> statement-breakpoint

CREATE VIEW subscription_standing AS SELECT u.rowid,s.user_id,a.id AS attempt_id,a.price_id,
 a.paid_ends_at_ms AS paid_period_ends_at_ms,a.paid_renewal_anchor_ms AS renewal_anchor_ms
 FROM subscriptions s JOIN users u ON u.id=s.user_id
 JOIN billing_attempt_context a ON a.id=s.current_paid_attempt_id AND a.user_id=s.user_id
 WHERE a.paid_starts_at_ms IS NOT NULL;
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000001','Restaurantes',0);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000002','Domicilios',1);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000003','Mercado',2);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000004','Transporte',3);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000005','Vivienda',4);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000006','Servicios',5);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000007','Salud',6);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000008','Educación',7);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000009','Compras',8);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000010','Entretenimiento',9);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000011','Viajes',10);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000012','Impuestos',11);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000013','Transferencias',12);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000014','Retiros de efectivo',13);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000015','Ingresos',14);
--> statement-breakpoint

INSERT INTO "categories"("id","label","display_order") VALUES('10000000-0000-4000-8000-000000000016','Otros',15);
--> statement-breakpoint

INSERT INTO "connection_institution_gate"("institution_id","enabled") VALUES('bancolombia',0);
--> statement-breakpoint

INSERT INTO "erasure_control"("kind","generation","cursor","scanned") VALUES('published','initial',NULL,NULL);
--> statement-breakpoint

INSERT INTO "recurring_dispatch"("id","last_user","next_discovery_at_ms") VALUES(1,'',0);
--> statement-breakpoint

INSERT INTO "sql_assertions"("scope","accepted") VALUES('statement_submission',1);
--> statement-breakpoint

INSERT INTO "statement_review_capacity"("id","pending_count") VALUES(1,0);
--> statement-breakpoint

INSERT INTO "subscription_prices"("id","amount","currency","billing_period","service_market","tax_treatment","terms_json","published_order") VALUES('22700000-0000-4000-8000-000000000001','9900','COP','weekly','CO','not-taxable','{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}',1);
--> statement-breakpoint

INSERT INTO "subscription_prices"("id","amount","currency","billing_period","service_market","tax_treatment","terms_json","published_order") VALUES('22700000-0000-4000-8000-000000000002','28900','COP','monthly','CO','not-taxable','{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}',2);
--> statement-breakpoint

INSERT INTO "subscription_prices"("id","amount","currency","billing_period","service_market","tax_treatment","terms_json","published_order") VALUES('22700000-0000-4000-8000-000000000003','289900','COP','yearly','CO','not-taxable','{"automaticRenewal":true,"renewalReminder":"none","cancellation":"future-renewals-only","paidAccessEnds":"paid-period-end","paymentMethods":["card","nequi","daviplata"]}',3);
--> statement-breakpoint

CREATE TRIGGER anonymized_email_sample_no_delete BEFORE DELETE ON anonymized_email_samples
BEGIN SELECT RAISE(ABORT, 'sample_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER anonymized_email_sample_no_update BEFORE UPDATE ON anonymized_email_samples
BEGIN SELECT RAISE(ABORT, 'sample_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
WHEN OLD.record_type IN ('session_call','credential_call','insight_call','publication')
 AND NOT EXISTS (
  SELECT 1 FROM audit_retention_permits WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms
 )
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
  WHERE p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id
  AND p.store_id=CASE OLD.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
--> statement-breakpoint

CREATE TABLE backup_recovery_credentials (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 code_digest BLOB NOT NULL UNIQUE CHECK(length(code_digest)=32),
 created_at_ms INTEGER NOT NULL,
 consumed_at_ms INTEGER,
 revision INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TRIGGER backup_recovery_credentials_field_fence_delete BEFORE DELETE ON backup_recovery_credentials WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER backup_recovery_credentials_field_fence_insert BEFORE INSERT ON backup_recovery_credentials WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER backup_recovery_credentials_field_fence_update BEFORE UPDATE ON backup_recovery_credentials WHEN (NEW.user_id IS NOT OLD.user_id OR NEW.code_digest IS NOT OLD.code_digest OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.consumed_at_ms IS NOT OLD.consumed_at_ms OR NEW.revision IS NOT OLD.revision) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER billing_access_adjustment_immutable BEFORE UPDATE OF access_ends_at_ms ON refund_attempts
WHEN OLD.access_ends_at_ms IS NOT NULL AND NEW.access_ends_at_ms IS NOT OLD.access_ends_at_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_access_adjustment_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_detached_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM subscription_cancellation_context WHERE payment_source_id=NEW.payment_source_id)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_detached');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_requires_claim BEFORE INSERT ON billing_attempts
WHEN NEW.status <> 'pending' OR NEW.finalized_at_ms IS NOT NULL
  OR NOT ((NEW.renewal_attempt_number = 1 AND NEW.previous_paid_attempt_id IS NULL AND NEW.calendar_anchor_ms IS NULL AND NEW.period_starts_at_ms IS NULL
    AND NEW.period_ends_at_ms IS NULL AND EXISTS (
  SELECT 1 FROM payment_enrollment_context AS e
  JOIN payment_source_context AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN subscription_prices AS p ON p.id = e.price_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)
    AND e.status = 'available' AND e.payment_request_id = NEW.payment_request_id
    AND e.price_id = NEW.price_id
    AND (SELECT amount FROM subscription_prices WHERE id=NEW.price_id) = p.amount AND (SELECT currency FROM subscription_prices WHERE id=NEW.price_id) = p.currency
    AND (SELECT billing_period FROM subscription_prices WHERE id=NEW.price_id) = p.billing_period AND (SELECT service_market FROM subscription_prices WHERE id=NEW.price_id) = p.service_market
    AND (SELECT tax_treatment FROM subscription_prices WHERE id=NEW.price_id) = p.tax_treatment
))
    OR (NEW.previous_paid_attempt_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM (SELECT * FROM subscription_standing) sub
  JOIN billing_attempt_context prior ON prior.id = sub.attempt_id AND prior.user_id = sub.user_id
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context WHERE paid_starts_at_ms IS NOT NULL) period ON period.attempt_id = prior.id
  JOIN payment_source_context source ON source.id = NEW.payment_source_id AND source.user_id = sub.user_id
  JOIN subscription_prices price ON price.id = NEW.price_id AND price.published_order IS NOT NULL
  WHERE sub.user_id = (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) AND prior.id = NEW.previous_paid_attempt_id
    AND prior.status = 'succeeded'
    AND prior.payment_source_id = source.id AND prior.enrollment_id = NEW.enrollment_id
    AND prior.wompi_environment = NEW.wompi_environment AND prior.time_zone = NEW.time_zone
    AND NEW.renewal_attempt_number = 1 AND NEW.payment_request_id = NEW.id
    AND NEW.period_starts_at_ms = period.ends_at_ms AND NEW.period_ends_at_ms > NEW.period_starts_at_ms
    AND NEW.created_at_ms >= period.ends_at_ms
    AND NEW.calendar_anchor_ms = COALESCE(prior.calendar_anchor_ms, period.starts_at_ms)
    AND price.billing_period = prior.billing_period AND price.service_market = prior.service_market
    AND (SELECT amount FROM subscription_prices WHERE id=NEW.price_id) = price.amount AND (SELECT currency FROM subscription_prices WHERE id=NEW.price_id) = price.currency
    AND (SELECT billing_period FROM subscription_prices WHERE id=NEW.price_id) = price.billing_period AND (SELECT service_market FROM subscription_prices WHERE id=NEW.price_id) = price.service_market
    AND (SELECT tax_treatment FROM subscription_prices WHERE id=NEW.price_id) = price.tax_treatment
    AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
))
    OR (NEW.renewal_attempt_number BETWEEN 2 AND 3 AND EXISTS (
      SELECT 1 FROM billing_attempt_context first
      JOIN billing_attempt_context last ON last.previous_paid_attempt_id = first.previous_paid_attempt_id
      JOIN (SELECT * FROM subscription_standing) sub ON sub.attempt_id = first.previous_paid_attempt_id AND sub.user_id = first.user_id
      WHERE first.renewal_attempt_number = 1 AND first.previous_paid_attempt_id = NEW.previous_paid_attempt_id
        AND first.user_id = (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) AND last.renewal_attempt_number = NEW.renewal_attempt_number - 1
        AND last.status = 'failed' AND first.enrollment_id = NEW.enrollment_id
        AND first.payment_source_id = NEW.payment_source_id AND first.price_id = NEW.price_id
        AND first.amount = (SELECT amount FROM subscription_prices WHERE id=NEW.price_id) AND first.currency = (SELECT currency FROM subscription_prices WHERE id=NEW.price_id)
        AND first.billing_period = (SELECT billing_period FROM subscription_prices WHERE id=NEW.price_id) AND first.service_market = (SELECT service_market FROM subscription_prices WHERE id=NEW.price_id)
        AND first.tax_treatment = (SELECT tax_treatment FROM subscription_prices WHERE id=NEW.price_id) AND first.time_zone = NEW.time_zone
        AND first.wompi_environment = NEW.wompi_environment AND NEW.payment_request_id = NEW.id
        AND first.calendar_anchor_ms = NEW.calendar_anchor_ms
        AND first.period_starts_at_ms = NEW.period_starts_at_ms AND first.period_ends_at_ms = NEW.period_ends_at_ms
        AND NEW.created_at_ms >= first.period_starts_at_ms + (NEW.renewal_attempt_number - 1) * 86400000
        AND NEW.created_at_ms < first.period_starts_at_ms + 259200000
        AND NOT EXISTS (SELECT 1 FROM billing_attempt_context sibling WHERE sibling.previous_paid_attempt_id = first.previous_paid_attempt_id
          AND (sibling.status <> 'failed' OR sibling.renewal_attempt_number >= NEW.renewal_attempt_number))
        AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = sub.user_id)
    )))
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_invalid_claim');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_retired_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM payment_source_context source WHERE source.id=NEW.payment_source_id AND source.retired_at_ms IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_retired');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) <> (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) OR NEW.enrollment_id <> OLD.enrollment_id
  OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.payment_source_id <> OLD.payment_source_id
  OR NEW.price_id <> OLD.price_id OR NEW.time_zone <> OLD.time_zone
  OR NEW.wompi_environment <> OLD.wompi_environment OR NEW.wompi_reference <> OLD.wompi_reference
  OR NEW.created_at_ms <> OLD.created_at_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_snapshot_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_terminal_monotonic BEFORE UPDATE ON billing_attempts
WHEN (OLD.status = 'succeeded' AND NEW.status <> 'succeeded')
  OR (OLD.status = 'failed' AND NEW.status = 'pending')
BEGIN
 SELECT RAISE(ABORT, 'billing_attempt_terminal_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_user_collection_guard BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM billing_attempt_context AS prior
  WHERE prior.user_id=(SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)
    AND (prior.status='pending' OR (prior.status='failed' AND prior.previous_paid_attempt_id IS NULL))
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,no_charge_reference AS wompi_reference,no_charge_environment AS wompi_environment,no_charge_case_id AS provider_case_id,no_charge_operator_id AS operator_id,no_charge_confirmed_at_ms AS confirmed_at_ms FROM billing_attempt_context WHERE no_charge_confirmed_at_ms IS NOT NULL) clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=prior.id)
    AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) stopped WHERE stopped.attempt_id=prior.id AND stopped.state='rejected'
      AND prior.previous_paid_attempt_id IS NOT NULL AND EXISTS (SELECT 1 FROM billing_attempt_context success
        JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id=success.id WHERE success.previous_paid_attempt_id=prior.previous_paid_attempt_id)))
BEGIN
 SELECT RAISE(ABORT, 'billing_user_collection_unresolved');
END;
--> statement-breakpoint

CREATE TRIGGER billing_calendar_anchor_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.calendar_anchor_ms IS NOT OLD.calendar_anchor_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_calendar_anchor_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_checkout_response_guard BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NULL AND NEW.checkout_transaction_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempt_context a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) arm ON arm.attempt_id=a.id
  JOIN (SELECT rowid,transaction_id,attempt_id,lookup_attempts,last_checked_at_ms FROM billing_provider_transactions) candidate ON candidate.attempt_id=a.id
  JOIN payment_source_context source ON source.id=a.payment_source_id AND source.user_id=a.user_id
  WHERE a.id=NEW.id AND candidate.transaction_id=NEW.checkout_transaction_id
    AND arm.state='sent' AND source.method='card' AND a.previous_paid_attempt_id IS NULL))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER billing_checkout_response_no_update BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NOT NULL AND (NEW.checkout_transaction_id IS NOT OLD.checkout_transaction_id) AND NOT(NEW.checkout_transaction_id IS NULL AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) AND q.user_id=p.user_id AND q.state='Erasing'))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_companions_initial BEFORE INSERT ON billing_attempts WHEN NEW.paid_starts_at_ms IS NOT NULL OR NEW.checkout_transaction_id IS NOT NULL OR NEW.followup_due_at_ms IS NOT NULL OR NEW.no_charge_confirmed_at_ms IS NOT NULL OR NEW.late_approval_observed_at_ms IS NOT NULL OR NEW.collection_state IS NOT 'armed' OR NEW.collection_sent_at_ms IS NOT NULL OR NEW.collection_last_attempt_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'billing_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_approval_monotonic BEFORE UPDATE ON billing_provider_transactions WHEN OLD.status='APPROVED' AND NEW.status IS NOT 'APPROVED' AND NOT(NEW.attempt_id IS NULL AND NEW.attempt_id IS NULL) BEGIN SELECT RAISE(ABORT,'billing_evidence_approval_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_immutable_identity BEFORE UPDATE ON billing_provider_transactions WHEN NEW.transaction_id IS NOT OLD.transaction_id OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id AND NOT(NEW.attempt_id IS NULL AND NEW.attempt_id IS NULL)) BEGIN SELECT RAISE(ABORT,'billing_evidence_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_evidence_reject_foreign_id BEFORE INSERT ON billing_provider_transactions
WHEN EXISTS (SELECT 1 FROM billing_provider_transactions AS e
  WHERE e.transaction_id = NEW.transaction_id AND e.attempt_id <> NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'billing_evidence_foreign_transaction'); END;
--> statement-breakpoint

CREATE TRIGGER billing_followup_cancellation_stop BEFORE UPDATE OF followup_due_at_ms ON billing_attempts
WHEN OLD.followup_due_at_ms IS NULL AND NEW.followup_due_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM subscription_cancellation_context c JOIN billing_attempt_context a ON a.user_id=c.user_id WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER billing_followup_refund_stop BEFORE UPDATE OF followup_due_at_ms ON billing_attempts
WHEN OLD.followup_due_at_ms IS NULL AND NEW.followup_due_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) s JOIN billing_attempt_context a ON a.user_id=s.user_id
 WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER billing_history_no_delete BEFORE DELETE ON billing_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.user_id=(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) AND p.store_id='billing_history' AND q.user_id=p.user_id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'billing_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_no_charge_immutable_update BEFORE UPDATE OF no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL AND (CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_reference END IS NOT CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_reference END OR CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_environment END IS NOT CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_environment END OR NEW.no_charge_case_id IS NOT OLD.no_charge_case_id OR NEW.no_charge_operator_id IS NOT OLD.no_charge_operator_id OR NEW.no_charge_confirmed_at_ms IS NOT OLD.no_charge_confirmed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_no_charge_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_no_charge_requires_sent_arm BEFORE UPDATE OF no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NULL AND NEW.no_charge_confirmed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempt_context AS a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) AS arm ON arm.attempt_id = a.id
  WHERE a.id = NEW.id AND a.wompi_reference = CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_reference END
    AND a.wompi_environment = CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_environment END AND a.status <> 'succeeded'
    AND arm.state = 'sent'))
BEGIN
 SELECT RAISE(ABORT, 'billing_no_charge_unverified_arm');
END;
--> statement-breakpoint

CREATE TRIGGER billing_paid_period_immutable_update BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NOT NULL AND (NEW.paid_starts_at_ms IS NOT OLD.paid_starts_at_ms OR NEW.paid_ends_at_ms IS NOT OLD.paid_ends_at_ms OR NEW.paid_renewal_anchor_ms IS NOT OLD.paid_renewal_anchor_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_paid_period_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_renewal_period_guard BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempt_context a WHERE a.id = NEW.id
  AND a.previous_paid_attempt_id IS NOT NULL AND
    (NEW.paid_starts_at_ms <> a.period_starts_at_ms OR NEW.paid_ends_at_ms <> a.period_ends_at_ms
      OR NEW.paid_renewal_anchor_ms <> a.period_ends_at_ms)))
BEGIN
 SELECT RAISE(ABORT, 'billing_renewal_period_mismatch');
END;
--> statement-breakpoint

CREATE TRIGGER billing_renewal_period_once BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempt_context a JOIN billing_attempt_context sibling
  ON sibling.previous_paid_attempt_id = a.previous_paid_attempt_id
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id = sibling.id
  WHERE a.id = NEW.id AND a.previous_paid_attempt_id IS NOT NULL))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER billing_renewal_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.previous_paid_attempt_id IS NOT OLD.previous_paid_attempt_id
  OR NEW.period_starts_at_ms IS NOT OLD.period_starts_at_ms

  OR NEW.period_ends_at_ms IS NOT OLD.period_ends_at_ms OR NEW.renewal_attempt_number <> OLD.renewal_attempt_number
BEGIN
 SELECT RAISE(ABORT, 'billing_renewal_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_renewal_success_fence AFTER UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL
BEGIN
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed' AND id<>NEW.id
    AND id IN (SELECT sibling.id FROM billing_attempt_context sibling JOIN billing_attempt_context success
      ON success.previous_paid_attempt_id=sibling.previous_paid_attempt_id WHERE success.id=NEW.id
      AND success.previous_paid_attempt_id IS NOT NULL);
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_approval_set_ready AFTER UPDATE OF approval_portfolio_id,approval_message_id,approval_user_id ON browser_login_pairings
WHEN OLD.approval_message_id IS NULL AND NEW.approval_message_id IS NOT NULL
BEGIN
 UPDATE browser_login_pairings SET state = 'ready', user_id = NEW.approval_user_id
  WHERE id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_approval_valid BEFORE UPDATE OF approval_portfolio_id,approval_message_id,approval_user_id ON browser_login_pairings
WHEN OLD.approval_message_id IS NULL AND NEW.approval_message_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p
  JOIN (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) AS w ON w.user_id = NEW.approval_user_id
  WHERE p.id = NEW.id AND p.state = 'pending_approval'
    AND w.portfolio_id = NEW.approval_portfolio_id
))
BEGIN
 SELECT RAISE(ABORT, 'browser_login_approval_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_pairings_companions_initial BEFORE INSERT ON browser_login_pairings WHEN NEW.approval_portfolio_id IS NOT NULL OR NEW.approval_message_id IS NOT NULL OR NEW.approval_user_id IS NOT NULL OR NEW.email_work_id IS NOT NULL OR NEW.email_user_id IS NOT NULL OR NEW.email_address IS NOT NULL OR NEW.email_credential_verified_at_ms IS NOT NULL OR NEW.email_state IS NOT NULL OR NEW.email_public_code IS NOT NULL OR NEW.email_proof_digest IS NOT NULL OR NEW.email_proof_expires_at_ms IS NOT NULL OR NEW.email_expires_at_ms IS NOT NULL OR NEW.email_generation IS NOT NULL OR NEW.email_wrong_attempts IS NOT NULL OR NEW.email_last_requested_at_ms IS NOT NULL OR NEW.email_dispatch_attempted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'browser_login_pairings_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.budget_delivery_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NEW.budget_delivery_group_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER budget_capacity BEFORE INSERT ON budgets
WHEN (SELECT COUNT(*) FROM budgets WHERE user_id = NEW.user_id) >= 128
BEGIN SELECT RAISE(ABORT, 'budget_capacity_limit'); END;
--> statement-breakpoint

CREATE TRIGGER budget_capture_work AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_correction_work AFTER UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1;
  INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',OLD.user_id, OLD.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_created_work AFTER INSERT ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_crossing_delivery_frozen BEFORE UPDATE OF delivery_group_id,consent_grant_id ON budget_threshold_alerts
WHEN NEW.delivery_group_id IS NOT OLD.delivery_group_id OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
BEGIN SELECT RAISE(ABORT,'budget_delivery_eligibility_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_crossing_facts_immutable BEFORE UPDATE ON budget_threshold_alerts
WHEN NEW.crossing_json IS NOT OLD.crossing_json
BEGIN SELECT RAISE(ABORT, 'budget_crossing_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_first_creation_capture AFTER INSERT ON budgets
BEGIN
 INSERT INTO budget_state(kind,user_id,budget_id,created_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,NEW.id,CAST(unixepoch(NEW.created_at)*1000 AS INTEGER),0,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET budget_id=excluded.budget_id,created_at_ms=excluded.created_at_ms,first_last_evaluated_at_ms=0 WHERE budget_state.budget_id IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_insert AFTER INSERT ON budget_month_plan_records
WHEN NEW.kind='currency'
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_update AFTER UPDATE ON budget_month_plan_records
WHEN (NEW.kind='currency' OR OLD.kind='currency')
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_link_work AFTER INSERT ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_month_plan_kind_immutable BEFORE UPDATE ON budget_month_plan_records WHEN NEW.kind IS NOT OLD.kind BEGIN SELECT RAISE(ABORT,'budget_month_plan_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_occurrence_frozen BEFORE UPDATE ON insight_events WHEN (NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) AND NOT((NEW.budget_delivery_group_id IS NULL AND NEW.budget_threshold IS NULL AND NEW.budget_crossing_json IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_occurrence_no_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='budget_alert_occurrences' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'budget_occurrence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_removed_version AFTER DELETE ON budgets
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='budgets' AND (OLD.user_id=q.user_id))
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',OLD.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
  DELETE FROM budget_state WHERE kind='work' AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM budgets WHERE user_id = OLD.user_id); END;
--> statement-breakpoint

CREATE TRIGGER budget_revised_work AFTER UPDATE ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_state_kind_immutable BEFORE UPDATE OF kind ON budget_state WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'budget_state_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER budget_unlink_work AFTER UPDATE ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET version = version + 1; END;
--> statement-breakpoint

CREATE TRIGGER budget_work_version_insert AFTER INSERT ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1; END;
--> statement-breakpoint

CREATE TRIGGER budget_work_version_update AFTER UPDATE ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1; END;
--> statement-breakpoint

CREATE TRIGGER canonical_request_concurrency BEFORE INSERT ON canonical_request_leases
WHEN (SELECT count(*) FROM canonical_request_leases WHERE user_id = NEW.user_id AND expires_at_ms > NEW.expires_at_ms - 90000) >= 2
BEGIN SELECT RAISE(ABORT,'canonical_request_concurrency'); END;
--> statement-breakpoint

CREATE TRIGGER card_enrollment_evidence_immutable BEFORE UPDATE ON payment_enrollments
WHEN (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) <> (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) OR NEW.price_id <> OLD.price_id
  OR ((OLD.status <> 'preparing' OR NEW.status <> 'prepared')
    AND (NEW.payment_source_mode <> OLD.payment_source_mode
      OR NEW.contracts_json <> OLD.contracts_json OR NEW.disclosure_json <> OLD.disclosure_json))
  OR NEW.prepared_at_ms <> OLD.prepared_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR (OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS NOT OLD.payment_request_id)
BEGIN SELECT RAISE(ABORT, 'card_enrollment_evidence_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER card_enrollment_preparation_limit BEFORE INSERT ON payment_enrollments
WHEN (SELECT count(*) FROM payment_enrollment_context WHERE user_id = (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)
  AND prepared_at_ms > NEW.prepared_at_ms - 3600000) >= 12
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint

CREATE TRIGGER commercial_allowance_capacity BEFORE INSERT ON commercial_allowance_consumptions
WHEN NEW.units = 1 AND NOT EXISTS (
  SELECT 1 FROM commercial_allowance_consumptions WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND identity = NEW.identity
) AND (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions
 WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND period_start_ms = NEW.period_start_ms) >=
 CASE NEW.allowance WHEN 'forwarded_email' THEN 30 WHEN 'media_submission' THEN 2 WHEN 'hosted_history_turn' THEN 2 WHEN 'canonical_call' THEN 50 END
BEGIN SELECT RAISE(ABORT, 'commercial_quota_exhausted'); END;
--> statement-breakpoint

CREATE TRIGGER connection_attempt_transition BEFORE UPDATE ON connection_attempts
WHEN OLD.status != 'pending' OR NEW.status = 'pending'
  OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.connection_id != OLD.connection_id
  OR NEW.institution_id != OLD.institution_id OR NEW.public_reference != OLD.public_reference
  OR NEW.created_at_ms != OLD.created_at_ms OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_attempt_transition'); END;
--> statement-breakpoint

CREATE TRIGGER connection_identity_immutable BEFORE UPDATE ON connections
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.institution_id != OLD.institution_id OR NEW.created_at_ms != OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER connection_preparation_binding BEFORE UPDATE ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=NEW.prepared_session_id AND s.user_id=NEW.user_id AND NEW.status='consumed')
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END;
--> statement-breakpoint

CREATE TRIGGER connection_preparation_immutable BEFORE UPDATE ON connection_attempts
WHEN OLD.prepared_session_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.prepared_session_id IS NOT OLD.prepared_session_id OR NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_execution_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER connection_preparation_initial BEFORE INSERT ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END;
--> statement-breakpoint

CREATE TRIGGER consent_history_no_delete BEFORE DELETE ON consent_history WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing' AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END)) BEGIN SELECT RAISE(ABORT,'consent_history_retention_required'); END;
--> statement-breakpoint

CREATE TRIGGER consent_history_no_update BEFORE UPDATE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER consent_offer_valid_insert BEFORE INSERT ON consent_offers
WHEN NOT json_valid(NEW.disclosure_json) OR NEW.expires_at_ms<=NEW.created_at_ms
 OR (NEW.decision IS NOT NULL AND NEW.disclosure_message_id IS NULL)
 OR (NEW.rejection_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM consent_history r WHERE r.user_id=NEW.user_id
   AND r.record_type='weekly_rejection' AND r.id=NEW.rejection_id))
 OR (NEW.replaces_offer_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM consent_offers old WHERE old.user_id=NEW.user_id
   AND old.kind=NEW.kind AND old.id=NEW.replaces_offer_id AND old.id<>NEW.id))
BEGIN SELECT RAISE(ABORT,'consent_offer_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER consent_offer_valid_update BEFORE UPDATE ON consent_offers
WHEN NOT json_valid(NEW.disclosure_json) OR NEW.expires_at_ms<=NEW.created_at_ms
 OR (NEW.decision IS NOT NULL AND NEW.disclosure_message_id IS NULL)
BEGIN SELECT RAISE(ABORT,'consent_offer_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER consent_history_offer_owner BEFORE INSERT ON consent_history
WHEN (NEW.weekly_offer_reference IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM consent_offers o WHERE o.user_id=NEW.user_id
   AND o.kind='weekly-summary' AND o.id=NEW.weekly_offer_reference))
 OR (NEW.proactivity_offer_reference IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM consent_offers o WHERE o.user_id=NEW.user_id
   AND o.kind=NEW.kind AND o.id=NEW.proactivity_offer_reference))
BEGIN SELECT RAISE(ABORT,'consent_history_offer_owner'); END;
--> statement-breakpoint

CREATE TRIGGER consent_offer_kind_immutable BEFORE UPDATE OF kind ON consent_offers WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'consent_offer_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_history
WHEN NEW.record_type='processing_withdrawal' AND NOT EXISTS (
  SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;
--> statement-breakpoint

CREATE TRIGGER custody_record_identity_immutable BEFORE UPDATE ON erasure_custody_records WHEN NEW.record_type IS NOT OLD.record_type OR NEW.request_id IS NOT OLD.request_id OR NEW.custodian IS NOT OLD.custodian OR NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'custody_record_identity_immutable'); END;
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

CREATE TRIGGER dashboard_projection_decision_insert AFTER INSERT ON transaction_reconciliation_decisions
BEGIN UPDATE dashboard_projection_state SET readiness = 'linking'
  WHERE user_id = NEW.user_id AND readiness = 'ready'; END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_decision_update AFTER UPDATE ON transaction_reconciliation_decisions
BEGIN UPDATE dashboard_projection_state SET readiness = 'linking'
  WHERE user_id = NEW.user_id AND readiness = 'ready'; END;
--> statement-breakpoint

CREATE TRIGGER dashboard_projection_deleted_transaction AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  DELETE FROM dashboard_projection_leaf WHERE user_id = OLD.user_id AND id = OLD.id;
END;
--> statement-breakpoint

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
--> statement-breakpoint

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

CREATE TRIGGER dashboard_projection_new_user AFTER INSERT ON users
BEGIN INSERT INTO dashboard_projection_state (user_id, version, readiness)
  VALUES (NEW.id, 1, 'ready'); END;
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

CREATE TRIGGER deleted_transaction_no_link BEFORE UPDATE OF reconciliation_first_id,reconciliation_second_id ON transactions WHEN NEW.reconciliation_first_id IS NOT NULL AND NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'transaction_deleted'); END;
--> statement-breakpoint

CREATE TRIGGER deleted_transaction_no_update BEFORE UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms) AND OLD.deleted_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'transaction_deleted'); END;
--> statement-breakpoint

CREATE TRIGGER email_forwarding_addresses_field_fence_delete BEFORE DELETE ON forwarding_addresses WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER email_forwarding_addresses_field_fence_insert BEFORE INSERT ON forwarding_addresses WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER email_forwarding_addresses_field_fence_update BEFORE UPDATE ON forwarding_addresses WHEN (NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.local_part IS NOT OLD.local_part OR NEW.issued_at_ms IS NOT OLD.issued_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_forwarding_addresses'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER email_forwarding_addresses_field_preserve_delete BEFORE DELETE ON forwarding_addresses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'email_forwarding_addresses','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.id,'user_id',OLD.user_id,'local_part',OLD.local_part,'created_at_ms',OLD.issued_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_entries_delete BEFORE DELETE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempt_context WHERE id=OLD.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE OLD.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_entries_insert BEFORE INSERT ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempt_context WHERE id=NEW.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_entries_update BEFORE UPDATE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND (COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempt_context WHERE id=NEW.attempt_id))=q.user_id OR COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempt_context WHERE id=OLD.attempt_id))=q.user_id)
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_delete BEFORE DELETE ON audit_retention_permits WHEN (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_insert BEFORE INSERT ON audit_retention_permits WHEN (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_retention_permits_update BEFORE UPDATE ON audit_retention_permits WHEN ((NEW.user_id IS NOT OLD.user_id OR NEW.cutoff_ms IS NOT OLD.cutoff_ms)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_attempts_insert BEFORE INSERT ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_attempts_update BEFORE UPDATE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) OR ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history')) AND NOT (EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) AND q.user_id=p.user_id AND q.state='Erasing') AND NEW.checkout_transaction_id IS NULL AND NEW.id IS OLD.id AND (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) IS (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) AND NEW.enrollment_id IS OLD.enrollment_id AND NEW.payment_request_id IS OLD.payment_request_id AND NEW.payment_source_id IS OLD.payment_source_id AND NEW.price_id IS OLD.price_id AND (SELECT amount FROM subscription_prices WHERE id=NEW.price_id) IS (SELECT amount FROM subscription_prices WHERE id=OLD.price_id) AND (SELECT currency FROM subscription_prices WHERE id=NEW.price_id) IS (SELECT currency FROM subscription_prices WHERE id=OLD.price_id) AND (SELECT billing_period FROM subscription_prices WHERE id=NEW.price_id) IS (SELECT billing_period FROM subscription_prices WHERE id=OLD.price_id) AND (SELECT service_market FROM subscription_prices WHERE id=NEW.price_id) IS (SELECT service_market FROM subscription_prices WHERE id=OLD.price_id) AND (SELECT tax_treatment FROM subscription_prices WHERE id=NEW.price_id) IS (SELECT tax_treatment FROM subscription_prices WHERE id=OLD.price_id) AND NEW.time_zone IS OLD.time_zone AND NEW.wompi_environment IS OLD.wompi_environment AND NEW.wompi_reference IS OLD.wompi_reference AND NEW.status IS OLD.status AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.finalized_at_ms IS OLD.finalized_at_ms AND NEW.previous_paid_attempt_id IS OLD.previous_paid_attempt_id AND NEW.period_starts_at_ms IS OLD.period_starts_at_ms AND NEW.period_ends_at_ms IS OLD.period_ends_at_ms AND NEW.calendar_anchor_ms IS OLD.calendar_anchor_ms AND NEW.renewal_attempt_number IS OLD.renewal_attempt_number AND NEW.paid_starts_at_ms IS OLD.paid_starts_at_ms AND NEW.paid_ends_at_ms IS OLD.paid_ends_at_ms AND NEW.paid_renewal_anchor_ms IS OLD.paid_renewal_anchor_ms AND NEW.collection_state IS OLD.collection_state AND NEW.collection_sent_at_ms IS OLD.collection_sent_at_ms AND NEW.collection_last_attempt_at_ms IS OLD.collection_last_attempt_at_ms AND NEW.followup_due_at_ms IS OLD.followup_due_at_ms AND CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_reference END IS CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_reference END AND CASE WHEN NEW.no_charge_confirmed_at_ms IS NOT NULL THEN NEW.wompi_environment END IS CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_environment END AND NEW.no_charge_case_id IS OLD.no_charge_case_id AND NEW.no_charge_operator_id IS OLD.no_charge_operator_id AND NEW.no_charge_confirmed_at_ms IS OLD.no_charge_confirmed_at_ms AND CASE WHEN NEW.late_approval_observed_at_ms IS NOT NULL THEN NEW.no_charge_case_id END IS CASE WHEN OLD.late_approval_observed_at_ms IS NOT NULL THEN OLD.no_charge_case_id END AND NEW.late_approval_observed_at_ms IS OLD.late_approval_observed_at_ms)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_delete BEFORE DELETE ON billing_provider_transactions WHEN OLD.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_insert BEFORE INSERT ON billing_provider_transactions WHEN NEW.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_update BEFORE UPDATE ON billing_provider_transactions WHEN (OLD.event_received_at_ms IS NOT NULL OR NEW.event_received_at_ms IS NOT NULL) AND (NEW.transaction_id IS NOT OLD.transaction_id OR NEW.event_row_ref IS NOT OLD.event_row_ref OR NEW.event_received_at_ms IS NOT OLD.event_received_at_ms OR NEW.event_signed_at IS NOT OLD.event_signed_at OR NEW.event_signed_status IS NOT OLD.event_signed_status OR NEW.event_lookup_attempts IS NOT OLD.event_lookup_attempts OR NEW.event_last_checked_at_ms IS NOT OLD.event_last_checked_at_ms OR NEW.event_resolved_at_ms IS NOT OLD.event_resolved_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_price_notices_delete BEFORE DELETE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_price_notices_insert BEFORE INSERT ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_price_notices_update BEFORE UPDATE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) OR ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_insert BEFORE INSERT ON billing_provider_transactions
WHEN NEW.attempt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_provider_transactions_update BEFORE UPDATE ON billing_provider_transactions
WHEN (NEW.transaction_id IS NOT OLD.transaction_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.lookup_attempts IS NOT OLD.lookup_attempts OR NEW.last_checked_at_ms IS NOT OLD.last_checked_at_ms OR NEW.status IS NOT OLD.status OR NEW.first_observed_at_ms IS NOT OLD.first_observed_at_ms OR NEW.negative_observed_at_ms IS NOT OLD.negative_observed_at_ms OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=NEW.attempt_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_provider_transactions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_delete BEFORE DELETE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_insert BEFORE INSERT ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_update BEFORE UPDATE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings')) AND NOT(NEW.id IS OLD.id AND NEW.public_code IS OLD.public_code AND NEW.verifier_digest IS OLD.verifier_digest AND NEW.user_id IS OLD.user_id AND NEW.state IS OLD.state AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.wrong_attempts IS OLD.wrong_attempts AND NEW.last_poll_at_ms IS OLD.last_poll_at_ms AND NEW.minimum_poll_interval_seconds IS OLD.minimum_poll_interval_seconds AND NEW.approval_portfolio_id IS OLD.approval_portfolio_id AND NEW.approval_message_id IS OLD.approval_message_id AND NEW.approval_user_id IS OLD.approval_user_id)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_delete BEFORE DELETE ON resource_admission_counters WHEN (OLD.policy_key='email.pairing.user.v1') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_insert BEFORE INSERT ON resource_admission_counters WHEN (NEW.policy_key='email.pairing.user.v1') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_update BEFORE UPDATE ON resource_admission_counters WHEN ((NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.used IS NOT OLD.used OR NEW.window_start_ms IS NOT OLD.window_start_ms OR NEW.window_ends_ms IS NOT OLD.window_ends_ms OR NEW.policy_key IS NOT OLD.policy_key) AND (OLD.policy_key='email.pairing.user.v1' OR NEW.policy_key='email.pairing.user.v1')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.owner_user_id=q.user_id) OR (OLD.owner_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_delete BEFORE DELETE ON budget_state WHEN (OLD.kind='publication') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_insert BEFORE INSERT ON budget_state WHEN (NEW.kind='publication') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_crossing_publications_update BEFORE UPDATE ON budget_state WHEN ((NEW.materialized_at_ms IS NOT OLD.materialized_at_ms OR NEW.user_id IS NOT OLD.user_id OR NEW.last_evaluated_at_ms IS NOT OLD.last_evaluated_at_ms OR NEW.detected_at_ms IS NOT OLD.detected_at_ms OR NEW.kind IS NOT OLD.kind OR NEW.record_id IS NOT OLD.record_id) AND (OLD.kind='publication' OR NEW.kind='publication')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='currency' OR OLD.kind='currency') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='cap' OR OLD.kind='cap') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_latches_delete BEFORE DELETE ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_latches_insert BEFORE INSERT ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_latches_update BEFORE UPDATE ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='plan' OR OLD.kind='plan') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_reconciliation_work_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_threshold_alerts_delete BEFORE DELETE ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_threshold_alerts_insert BEFORE INSERT ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_threshold_alerts_update BEFORE UPDATE ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_user_versions_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budgets_delete BEFORE DELETE ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budgets_insert BEFORE INSERT ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budgets_update BEFORE UPDATE ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_buckets_delete BEFORE DELETE ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.subject='user:'||q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_buckets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_buckets_insert BEFORE INSERT ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.subject='user:'||q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_buckets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_buckets_update BEFORE UPDATE ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.subject='user:'||q.user_id) OR (OLD.subject='user:'||q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_buckets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_leases_delete BEFORE DELETE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_leases_insert BEFORE INSERT ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_leases_update BEFORE UPDATE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_replays_delete BEFORE DELETE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_replays_insert BEFORE INSERT ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_canonical_request_replays_update BEFORE UPDATE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_delete BEFORE DELETE ON payment_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_insert BEFORE INSERT ON payment_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_card_enrollments_update BEFORE UPDATE ON payment_enrollments
WHEN (NEW.id IS NOT OLD.id OR (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) IS NOT (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id) OR NEW.price_id IS NOT OLD.price_id OR NEW.billing_email IS NOT OLD.billing_email OR NEW.status IS NOT OLD.status OR NEW.payment_source_mode IS NOT OLD.payment_source_mode OR NEW.contracts_json IS NOT OLD.contracts_json OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.accepted_at_ms IS NOT OLD.accepted_at_ms OR NEW.payment_request_id IS NOT OLD.payment_request_id OR NEW.wompi_candidate_source_id IS NOT OLD.wompi_candidate_source_id OR NEW.verification_attempts IS NOT OLD.verification_attempts OR NEW.last_verification_at_ms IS NOT OLD.last_verification_at_ms OR NEW.refusal_reason IS NOT OLD.refusal_reason OR NEW.method IS NOT OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment OR NEW.authorization_digest IS NOT OLD.authorization_digest) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) OR ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_commercial_allowance_consumptions_delete BEFORE DELETE ON commercial_allowance_consumptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='commercial_allowance_consumptions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_commercial_allowance_consumptions_insert BEFORE INSERT ON commercial_allowance_consumptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='commercial_allowance_consumptions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_commercial_allowance_consumptions_update BEFORE UPDATE ON commercial_allowance_consumptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='commercial_allowance_consumptions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_attempts_delete BEFORE DELETE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_attempts_insert BEFORE INSERT ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_attempts_update BEFORE UPDATE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connections_delete BEFORE DELETE ON connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connections_insert BEFORE INSERT ON connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connections_update BEFORE UPDATE ON connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_consent_history_insert BEFORE INSERT ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE (q.state NOT IN('AwaitingReview','Draining') OR (NEW.record_type='processing_renewal' AND q.state='Draining')) AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_consent_history_update BEFORE UPDATE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard')) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_documents_insert BEFORE INSERT ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='dashboard')) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_documents_update BEFORE UPDATE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((NEW.user_id=q.user_id AND NEW.kind='dashboard')) OR ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_bucket_delete BEFORE DELETE ON dashboard_projection_bucket
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_bucket'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_bucket_insert BEFORE INSERT ON dashboard_projection_bucket
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_bucket'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_bucket_update BEFORE UPDATE ON dashboard_projection_bucket
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_bucket'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_digit_delete BEFORE DELETE ON dashboard_projection_digit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_digit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_digit_insert BEFORE INSERT ON dashboard_projection_digit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_digit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_digit_update BEFORE UPDATE ON dashboard_projection_digit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_digit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_leaf_delete BEFORE DELETE ON dashboard_projection_leaf
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_leaf'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_leaf_insert BEFORE INSERT ON dashboard_projection_leaf
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_leaf'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_leaf_update BEFORE UPDATE ON dashboard_projection_leaf
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_leaf'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_state_delete BEFORE DELETE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_state_insert BEFORE INSERT ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_dashboard_projection_state_update BEFORE UPDATE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_delete BEFORE DELETE ON resource_admission_counters WHEN (OLD.policy_key='email.replacement.user.v1') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_insert BEFORE INSERT ON resource_admission_counters WHEN (NEW.policy_key='email.replacement.user.v1') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_update BEFORE UPDATE ON resource_admission_counters WHEN ((NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.last_work_id IS NOT OLD.last_work_id OR NEW.used IS NOT OLD.used OR NEW.window_start_ms IS NOT OLD.window_start_ms OR NEW.window_ends_ms IS NOT OLD.window_ends_ms OR NEW.policy_key IS NOT OLD.policy_key) AND (OLD.policy_key='email.replacement.user.v1' OR NEW.policy_key='email.replacement.user.v1')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.owner_user_id=q.user_id) OR (OLD.owner_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacements_delete BEFORE DELETE ON email_replacements
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacements'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacements_insert BEFORE INSERT ON email_replacements
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacements'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacements_update BEFORE UPDATE ON email_replacements
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacements'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_forwarded_email_receipts_insert BEFORE INSERT ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_forwarded_email_receipts_update BEFORE UPDATE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_agent_sessions_delete BEFORE DELETE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_agent_sessions_insert BEFORE INSERT ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_agent_sessions_update BEFORE UPDATE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_compaction_attempts_delete BEFORE DELETE ON resource_admission_counters
WHEN (OLD.policy_key='hosted.compaction.user.v1') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_compaction_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_compaction_attempts_insert BEFORE INSERT ON resource_admission_counters
WHEN (NEW.policy_key='hosted.compaction.user.v1') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_compaction_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_compaction_attempts_update BEFORE UPDATE ON resource_admission_counters
WHEN (OLD.policy_key='hosted.compaction.user.v1' OR NEW.policy_key='hosted.compaction.user.v1') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.owner_user_id=q.user_id) OR (OLD.owner_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_compaction_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_confirmations_delete BEFORE DELETE ON hosted_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_confirmations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_confirmations_insert BEFORE INSERT ON hosted_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_confirmations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_confirmations_update BEFORE UPDATE ON hosted_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_confirmations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_mutation_commits_delete BEFORE DELETE ON hosted_mutation_commits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_mutation_commits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_mutation_commits_insert BEFORE INSERT ON hosted_mutation_commits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_mutation_commits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_mutation_commits_update BEFORE UPDATE ON hosted_mutation_commits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_mutation_commits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_turns_delete BEFORE DELETE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_turns_insert BEFORE INSERT ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_turns_update BEFORE UPDATE ON hosted_turns
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.hosted_session_id IS NOT OLD.hosted_session_id OR NEW.started_at_ms IS NOT OLD.started_at_ms OR NEW.terminal_at_ms IS NOT OLD.terminal_at_ms OR NEW.status IS NOT OLD.status OR NEW.failure_reason IS NOT OLD.failure_reason OR NEW.proposal_receipt_digest IS NOT OLD.proposal_receipt_digest OR NEW.proposed_at_ms IS NOT OLD.proposed_at_ms OR NEW.proposal_text IS NOT OLD.proposal_text OR NEW.retention_terminal_at_ms IS NOT OLD.retention_terminal_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_insert BEFORE INSERT ON whatsapp_event_records
WHEN NEW.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_update BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='voice-refusal' OR NEW.kind='voice-refusal') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_insert BEFORE INSERT ON whatsapp_event_records
WHEN NEW.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_update BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='delivery-status' OR NEW.kind='delivery-status') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_windows_delete BEFORE DELETE ON hosted_whatsapp_windows
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_windows'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_windows_insert BEFORE INSERT ON hosted_whatsapp_windows
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_windows'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_windows_update BEFORE UPDATE ON hosted_whatsapp_windows
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_windows'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_state_delete BEFORE DELETE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_state_insert BEFORE INSERT ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_state_update BEFORE UPDATE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_insert BEFORE INSERT ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_events_update BEFORE UPDATE ON insight_events
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.schedule_version IS NOT OLD.schedule_version OR NEW.service_market IS NOT OLD.service_market OR NEW.locale IS NOT OLD.locale OR NEW.time_zone IS NOT OLD.time_zone OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.money_groups_json IS NOT OLD.money_groups_json OR NEW.lifecycle_state IS NOT OLD.lifecycle_state) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_update BEFORE UPDATE ON insight_reports
WHEN (NEW.kind IS NOT OLD.kind OR NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id OR NEW.origin IS NOT OLD.origin OR NEW.request_message_id IS NOT OLD.request_message_id OR NEW.rejection_offer_id IS NOT OLD.rejection_offer_id OR NEW.request_kind IS NOT OLD.request_kind OR NEW.materialized_at_ms IS NOT OLD.materialized_at_ms OR NEW.last_evaluated_at_ms IS NOT OLD.last_evaluated_at_ms OR NEW.offer_delivery_id IS NOT OLD.offer_delivery_id OR NEW.current_recurring_opportunity IS NOT OLD.current_recurring_opportunity OR NEW.role IS NOT OLD.role OR NEW.consent_grant_id IS NOT OLD.consent_grant_id OR NEW.offer_id IS NOT OLD.offer_id OR NEW.text IS NOT OLD.text OR NEW.scheduled_at_ms IS NOT OLD.scheduled_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.time_zone IS NOT OLD.time_zone OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.payload_json IS NOT OLD.payload_json OR NEW.presentation_json IS NOT OLD.presentation_json OR NEW.reminder_grant_id IS NOT OLD.reminder_grant_id OR NEW.reminder_expires_at_ms IS NOT OLD.reminder_expires_at_ms OR NEW.instruction_id IS NOT OLD.instruction_id OR NEW.instruction_version IS NOT OLD.instruction_version OR NEW.grant_id IS NOT OLD.grant_id OR NEW.local_date IS NOT OLD.local_date OR NEW.day_from_ms IS NOT OLD.day_from_ms OR NEW.day_to_ms IS NOT OLD.day_to_ms OR NEW.report_json IS NOT OLD.report_json OR NEW.dispatch_state IS NOT OLD.dispatch_state OR NEW.dispatch_created_at_ms IS NOT OLD.dispatch_created_at_ms OR NEW.dispatch_last_attempt_at_ms IS NOT OLD.dispatch_last_attempt_at_ms OR NEW.dispatch_restart_attempts IS NOT OLD.dispatch_restart_attempts) AND (OLD.kind IN ('weekly-summary','proactivity-delivery') OR NEW.kind IN ('weekly-summary','proactivity-delivery')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_keyword_rules_delete BEFORE DELETE ON keyword_rules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='keyword_rules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_keyword_rules_insert BEFORE INSERT ON keyword_rules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='keyword_rules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_keyword_rules_update BEFORE UPDATE ON keyword_rules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='keyword_rules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_media_submissions_delete BEFORE DELETE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='media_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_media_submissions_insert BEFORE INSERT ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='media_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_media_submissions_update BEFORE UPDATE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='media_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_memories_delete BEFORE DELETE ON memories
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='memories'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_memories_insert BEFORE INSERT ON memories
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='memories'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_memories_update BEFORE UPDATE ON memories
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='memories'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_access_credentials_delete BEFORE DELETE ON oauth_credentials
WHEN OLD.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_access_credentials_insert BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_access_credentials_update BEFORE UPDATE ON oauth_credentials
WHEN NEW.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_connections_delete BEFORE DELETE ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_connections_insert BEFORE INSERT ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_connections_update BEFORE UPDATE ON oauth_connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_connections'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_operation_intents_delete BEFORE DELETE ON oauth_operation_intents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_operation_intents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_operation_intents_insert BEFORE INSERT ON oauth_operation_intents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_operation_intents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_operation_intents_update BEFORE UPDATE ON oauth_operation_intents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_operation_intents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_delete BEFORE DELETE ON oauth_credentials
WHEN OLD.kind='refresh' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_insert BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='refresh' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_update BEFORE UPDATE ON oauth_credentials
WHEN NEW.kind='refresh' AND NOT (
 NEW.replacement_refresh_id IS NULL AND NEW.refresh_event_id IS NULL AND NEW.refresh_event_row_ref IS NULL
 AND NEW.consumed_at_ms IS OLD.consumed_at_ms
 AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id AND q.user_id=p.user_id
 WHERE p.store_id='oauth_refresh_events' AND p.user_id=OLD.user_id AND q.state='Erasing')
) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_review_requests_delete BEFORE DELETE ON oauth_review_requests
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_review_requests'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_review_requests_insert BEFORE INSERT ON oauth_review_requests
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_review_requests'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_oauth_review_requests_update BEFORE UPDATE ON oauth_review_requests
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_review_requests'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_pairings_delete BEFORE DELETE ON pat_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_pairings_insert BEFORE INSERT ON pat_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_pairings_update BEFORE UPDATE ON pat_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_review_attempts_delete BEFORE DELETE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.policy_key='pat.review.session.v1' AND OLD.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_review_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_review_attempts_insert BEFORE INSERT ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.policy_key='pat.review.session.v1' AND NEW.owner_user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_review_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pat_review_attempts_update BEFORE UPDATE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.policy_key='pat.review.session.v1' AND NEW.owner_user_id=q.user_id) OR (OLD.policy_key='pat.review.session.v1' AND OLD.owner_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_review_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pats_delete BEFORE DELETE ON pats
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pats'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pats_insert BEFORE INSERT ON pats
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pats'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pats_update BEFORE UPDATE ON pats
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pats'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pending_consent_exchanges_insert BEFORE INSERT ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_pending_consent_exchanges_update BEFORE UPDATE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=NEW.portfolio_id AND w.bsuid=NEW.bsuid)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pending_consent_exchanges'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_entries_delete BEFORE DELETE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_entries_insert BEFORE INSERT ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_entries_update BEFORE UPDATE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_delete BEFORE DELETE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_insert BEFORE INSERT ON insight_events WHEN (NEW.transcript_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactive_transcript_event_links_update BEFORE UPDATE ON insight_events WHEN ((NEW.id IS NOT OLD.id OR NEW.transcript_id IS NOT OLD.transcript_id OR NEW.transcript_kind IS NOT OLD.transcript_kind) AND (OLD.transcript_id IS NOT NULL OR NEW.transcript_id IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactive_transcript_event_links'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_consent_offers_insert BEFORE INSERT ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_consent_offers_update BEFORE UPDATE ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_delete BEFORE DELETE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_insert BEFORE INSERT ON insight_events WHEN (NEW.report_delivery_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_message_events_update BEFORE UPDATE ON insight_events WHEN ((NEW.id IS NOT OLD.id OR NEW.report_delivery_id IS NOT OLD.report_delivery_id) AND (OLD.report_delivery_id IS NOT NULL OR NEW.report_delivery_id IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_message_events'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')) AND NOT(NEW.delivery_id IS OLD.delivery_id AND NEW.user_id IS OLD.user_id AND NEW.request_kind IS OLD.request_kind AND NEW.request_message_id IS OLD.request_message_id AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.materialized_at_ms IS OLD.materialized_at_ms AND NEW.last_evaluated_at_ms IS OLD.last_evaluated_at_ms AND NEW.offer_delivery_id IS OLD.offer_delivery_id))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_authentication_attempts_delete BEFORE DELETE ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_authentication_attempts_insert BEFORE INSERT ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_authentication_attempts_update BEFORE UPDATE ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_credentials_delete BEFORE DELETE ON provider_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_credentials_insert BEFORE INSERT ON provider_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_provider_credentials_update BEFORE UPDATE ON provider_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_insert_shared BEFORE INSERT ON recurring_digest_items
WHEN NEW.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_update_shared BEFORE UPDATE ON recurring_digest_items
WHEN (NEW.disposition IS NOT OLD.disposition OR NEW.user_id IS NOT OLD.user_id OR NEW.confirmation_id IS NOT OLD.confirmation_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='digest-day' OR NEW.record_type='digest-day') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_delete BEFORE DELETE ON schedules
WHEN OLD.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_insert BEFORE INSERT ON schedules
WHEN NEW.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_update BEFORE UPDATE ON schedules
WHEN (OLD.kind='digest' OR NEW.kind='digest') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_insert_shared BEFORE INSERT ON recurring_digest_items
WHEN NEW.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_update_shared BEFORE UPDATE ON recurring_digest_items
WHEN (NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms OR NEW.context_json IS NOT OLD.context_json OR NEW.item_json IS NOT OLD.item_json OR NEW.eligible IS NOT OLD.eligible OR NEW.user_id IS NOT OLD.user_id OR NEW.confirmation_id IS NOT OLD.confirmation_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_dispatch_delete BEFORE DELETE ON recurring_dispatch
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.last_user=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_dispatch'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_dispatch_insert BEFORE INSERT ON recurring_dispatch
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.last_user=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_dispatch'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_dispatch_update BEFORE UPDATE ON recurring_dispatch
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.last_user=q.user_id) OR (OLD.last_user=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_dispatch'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='fact' OR OLD.kind='fact') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_plan_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id AND OLD.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_plan_documents_insert BEFORE INSERT ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_plan_documents_update BEFORE UPDATE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='recurring-plan') OR (OLD.user_id=q.user_id AND OLD.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_delete BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_insert BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_update BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='progress' OR OLD.kind='progress') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='proposal' OR OLD.kind='proposal') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_series_delete BEFORE DELETE ON recurring_series
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_series'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_series_insert BEFORE INSERT ON recurring_series
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_series'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_series_update BEFORE UPDATE ON recurring_series
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_series') AND NOT (EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=OLD.user_id AND p.store_id='recurring_confirmations' AND p.request_id=q.id) AND NEW.user_id IS OLD.user_id AND NEW.id IS OLD.id AND NEW.currency IS OLD.currency AND NEW.counterparty_key IS OLD.counterparty_key AND NEW.series_json IS OLD.series_json AND NEW.evidence_json IS OLD.evidence_json AND NEW.reference_json IS OLD.reference_json AND NEW.valid IS OLD.valid))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_refund_attempts_insert BEFORE INSERT ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_refund_attempts_update BEFORE UPDATE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='refund_attempts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_reminder_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_reminder_governors_insert BEFORE INSERT ON proactivity_governors
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_reminder_governors_update BEFORE UPDATE ON proactivity_governors
WHEN NEW.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_resource_admission_events_delete BEFORE DELETE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.policy_key<>'pat.review.session.v1' AND OLD.scope_key=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='resource_admission_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_resource_admission_events_insert BEFORE INSERT ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.policy_key<>'pat.review.session.v1' AND NEW.scope_key=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='resource_admission_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_resource_admission_events_update BEFORE UPDATE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.policy_key<>'pat.review.session.v1' AND NEW.scope_key=q.user_id) OR (OLD.policy_key<>'pat.review.session.v1' AND OLD.scope_key=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='resource_admission_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='execution' OR NEW.record_type='execution') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='revision' OR NEW.record_type='revision') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_delete BEFORE DELETE ON schedules
WHEN OLD.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_insert BEFORE INSERT ON schedules
WHEN NEW.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_update BEFORE UPDATE ON schedules
WHEN (OLD.kind IN ('weekly','reminder') OR NEW.kind IN ('weekly','reminder')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_source_attestations_delete BEFORE DELETE ON source_attestations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='source_attestations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_source_attestations_insert BEFORE INSERT ON source_attestations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='source_attestations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_source_attestations_update BEFORE UPDATE ON source_attestations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='source_attestations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materialization_parts_delete BEFORE DELETE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materialization_parts_insert BEFORE INSERT ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materialization_parts_update BEFORE UPDATE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_needs_review_delete BEFORE DELETE ON ingestion_review_items
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_needs_review'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_needs_review_insert BEFORE INSERT ON ingestion_review_items
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_needs_review'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_needs_review_update BEFORE UPDATE ON ingestion_review_items
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.source_kind IS NOT OLD.source_kind OR NEW.email_receipt_id IS NOT OLD.email_receipt_id OR NEW.media_submission_id IS NOT OLD.media_submission_id OR NEW.statement_submission_id IS NOT OLD.statement_submission_id OR NEW.record_number IS NOT OLD.record_number OR NEW.reason IS NOT OLD.reason OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.evidence_expires_at_ms IS NOT OLD.evidence_expires_at_ms OR NEW.service_market IS NOT OLD.service_market OR NEW.locale IS NOT OLD.locale OR NEW.time_zone IS NOT OLD.time_zone OR NEW.source_format IS NOT OLD.source_format OR NEW.parser_revision IS NOT OLD.parser_revision OR NEW.extractor_revision IS NOT OLD.extractor_revision OR NEW.original_evidence IS NOT OLD.original_evidence OR NEW.known_money_json IS NOT OLD.known_money_json OR NEW.issues_json IS NOT OLD.issues_json OR NEW.evidence_state IS NOT OLD.evidence_state OR NEW.suggestions_json IS NOT OLD.suggestions_json) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_needs_review'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_record_outcomes_delete BEFORE DELETE ON statement_record_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_record_outcomes'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_record_outcomes_insert BEFORE INSERT ON statement_record_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_record_outcomes'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_record_outcomes_update BEFORE UPDATE ON statement_record_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_record_outcomes'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_staging_objects_delete BEFORE DELETE ON statement_staging_objects
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_staging_objects'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_staging_objects_insert BEFORE INSERT ON statement_staging_objects
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_staging_objects'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_staging_objects_update BEFORE UPDATE ON statement_staging_objects
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_staging_objects'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_submissions_insert BEFORE INSERT ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_submissions_update BEFORE UPDATE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_delete BEFORE DELETE ON subscription_cancellations
WHEN OLD.cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_insert BEFORE INSERT ON subscription_cancellations
WHEN NEW.cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_update BEFORE UPDATE ON subscription_cancellations
WHEN (NEW.paid_attempt_id IS NOT OLD.paid_attempt_id OR NEW.payment_source_id IS NOT OLD.payment_source_id OR NEW.cancelled_at_ms IS NOT OLD.cancelled_at_ms OR NEW.paid_through_ms IS NOT OLD.paid_through_ms OR NEW.source_cancellation_state IS NOT OLD.source_cancellation_state OR NEW.void_started_at_ms IS NOT OLD.void_started_at_ms OR NEW.void_verified_at_ms IS NOT OLD.void_verified_at_ms OR NEW.verification_count IS NOT OLD.verification_count OR NEW.last_offered_at_ms IS NOT OLD.last_offered_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) OR ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_delete BEFORE DELETE ON subscriptions WHEN (OLD.current_paid_attempt_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_insert BEFORE INSERT ON subscriptions WHEN (NEW.current_paid_attempt_id IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscriptions_update BEFORE UPDATE ON subscriptions WHEN NEW.current_paid_attempt_id IS NOT OLD.current_paid_attempt_id AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscriptions'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_support_recovery_cases_delete BEFORE DELETE ON support_recovery_cases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='support_recovery_cases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_support_recovery_cases_insert BEFORE INSERT ON support_recovery_cases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='support_recovery_cases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_support_recovery_cases_update BEFORE UPDATE OF id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms ON support_recovery_cases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='support_recovery_cases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_corrections_delete BEFORE DELETE ON transaction_corrections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_corrections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_corrections_insert BEFORE INSERT ON transaction_corrections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_corrections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_corrections_update BEFORE UPDATE ON transaction_corrections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_corrections'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_decisions_delete BEFORE DELETE ON transaction_reconciliation_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_decisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_decisions_insert BEFORE INSERT ON transaction_reconciliation_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_decisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_decisions_update BEFORE UPDATE ON transaction_reconciliation_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_decisions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_delete BEFORE DELETE ON transactions WHEN OLD.reconciliation_first_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_insert BEFORE INSERT ON transactions WHEN NEW.reconciliation_first_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transaction_reconciliation_members_update BEFORE UPDATE ON transactions WHEN (OLD.reconciliation_first_id IS NOT NULL OR NEW.reconciliation_first_id IS NOT NULL) AND (NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.reconciliation_first_id IS NOT OLD.reconciliation_first_id OR NEW.reconciliation_second_id IS NOT OLD.reconciliation_second_id OR NEW.reconciliation_row_ref IS NOT OLD.reconciliation_row_ref) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id) OR (NEW.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transaction_reconciliation_members')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
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

CREATE TRIGGER erasure_fence_transcript_entries_delete BEFORE DELETE ON transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transcript_entries_insert BEFORE INSERT ON transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_transcript_entries_update BEFORE UPDATE ON transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='transcript_entries'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_users_delete BEFORE DELETE ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_users_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_users_update BEFORE UPDATE ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users')) AND NOT(NEW.id IS OLD.id AND NEW.service_market IS OLD.service_market AND NEW.locale IS OLD.locale AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.trial_started_at_ms IS OLD.trial_started_at_ms AND NEW.trial_ends_at_ms IS OLD.trial_ends_at_ms)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_web_sessions_delete BEFORE DELETE ON web_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='web_sessions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_web_sessions_insert BEFORE INSERT ON web_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='web_sessions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_web_sessions_update BEFORE UPDATE ON web_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='web_sessions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_consent_offers_insert BEFORE INSERT ON consent_offers
WHEN NEW.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_consent_offers_update BEFORE UPDATE ON consent_offers
WHEN NEW.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governor_questions_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governor_questions_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governor_questions_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governors_insert BEFORE INSERT ON proactivity_governors
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_governors_update BEFORE UPDATE ON proactivity_governors
WHEN NEW.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governors'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='weekly-question' OR NEW.kind='weekly-question') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_delete BEFORE DELETE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_insert BEFORE INSERT ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_update BEFORE UPDATE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_billing_transition BEFORE DELETE ON audit_entries
WHEN OLD.record_type='billing_transition' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_audit','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'transition',OLD."transition",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_identity_read BEFORE DELETE ON audit_entries
WHEN OLD.record_type='identity_read' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_user_reads','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_insight_call BEFORE DELETE ON audit_entries
WHEN OLD.record_type='insight_call' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'hosted_turn_id',OLD."hosted_turn_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_media_admission BEFORE DELETE ON audit_entries
WHEN OLD.record_type='media_admission' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submission_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_publication BEFORE DELETE ON audit_entries
WHEN OLD.record_type='publication' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'ingestion_publication_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_reminder_control BEFORE DELETE ON audit_entries
WHEN OLD.record_type='reminder_control' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_control_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'message_id',json_extract(OLD.id,'$[1]'),'choice',OLD.outcome)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_request_admission BEFORE DELETE ON audit_entries
WHEN OLD.record_type='request_admission' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_acceptances','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'operation',OLD."operation",'accepted_at_ms',OLD."accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_security_mutation BEFORE DELETE ON audit_entries
WHEN OLD.record_type='security_mutation' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_security_mutations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_session_call BEFORE DELETE ON audit_entries
WHEN OLD.record_type='session_call' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'session_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_retention_permits_delete BEFORE DELETE ON audit_retention_permits WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'audit_retention_permits','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'cutoff_ms',OLD.cutoff_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_history','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id),'enrollment_id',OLD."enrollment_id",'payment_request_id',OLD."payment_request_id",'payment_source_id',OLD."payment_source_id",'price_id',OLD."price_id",'amount',(SELECT amount FROM subscription_prices WHERE id=OLD.price_id),'currency',(SELECT currency FROM subscription_prices WHERE id=OLD.price_id),'billing_period',(SELECT billing_period FROM subscription_prices WHERE id=OLD.price_id),'service_market',(SELECT service_market FROM subscription_prices WHERE id=OLD.price_id),'tax_treatment',(SELECT tax_treatment FROM subscription_prices WHERE id=OLD.price_id),'time_zone',OLD."time_zone",'wompi_environment',OLD."wompi_environment",'wompi_reference',OLD."wompi_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'finalized_at_ms',OLD."finalized_at_ms",'previous_paid_attempt_id',OLD."previous_paid_attempt_id",'period_starts_at_ms',OLD."period_starts_at_ms",'period_ends_at_ms',OLD."period_ends_at_ms",'attempt_number',1,'calendar_anchor_ms',OLD."calendar_anchor_ms",'renewal_attempt_number',OLD."renewal_attempt_number",'paid_starts_at_ms',OLD.paid_starts_at_ms,'paid_ends_at_ms',OLD.paid_ends_at_ms,'paid_renewal_anchor_ms',OLD.paid_renewal_anchor_ms,'checkout_transaction_id',OLD.checkout_transaction_id,'collection_state',OLD.collection_state,'collection_sent_at_ms',OLD.collection_sent_at_ms,'collection_last_attempt_at_ms',OLD.collection_last_attempt_at_ms,'followup_kind',CASE WHEN OLD.followup_due_at_ms IS NOT NULL THEN 'renewal_due' END,'followup_due_at_ms',OLD.followup_due_at_ms,'no_charge_reference',CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_reference END,'no_charge_environment',CASE WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL THEN OLD.wompi_environment END,'no_charge_case_id',OLD.no_charge_case_id,'no_charge_operator_id',OLD.no_charge_operator_id,'no_charge_confirmed_at_ms',OLD.no_charge_confirmed_at_ms,'recovery_case_id',CASE WHEN OLD.late_approval_observed_at_ms IS NOT NULL THEN OLD.no_charge_case_id END,'recovery_reviewed_at_ms',OLD.late_approval_observed_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_event_candidates_delete BEFORE DELETE ON billing_provider_transactions
WHEN OLD.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."event_received_at_ms",'signed_at',OLD."event_signed_at",'signed_status',OLD."event_signed_status",'lookup_attempts',OLD."event_lookup_attempts",'last_checked_at_ms',OLD."event_last_checked_at_ms",'resolved_at_ms',OLD."event_resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_event_candidates_update BEFORE UPDATE ON billing_provider_transactions
WHEN OLD.event_received_at_ms IS NOT NULL AND NEW.event_received_at_ms IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."event_received_at_ms",'signed_at',OLD."event_signed_at",'signed_status',OLD."event_signed_status",'lookup_attempts',OLD."event_lookup_attempts",'last_checked_at_ms',OLD."event_last_checked_at_ms",'resolved_at_ms',OLD."event_resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_price_notices_delete BEFORE DELETE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_price_notices','drain:'||lower(hex(randomblob(16))),json_object('user_id',(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id),'price_id',OLD."price_id",'created_at_ms',OLD."created_at_ms",'last_offered_at_ms',OLD."last_offered_at_ms",'send_started_at_ms',OLD."send_started_at_ms",'provider_accepted_at_ms',OLD."provider_accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_billing_provider_transactions_delete BEFORE DELETE ON billing_provider_transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_provider_transactions','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms",'status',OLD.status,'first_observed_at_ms',OLD.first_observed_at_ms,'negative_observed_at_ms',OLD.negative_observed_at_ms,'finalized_at_ms',OLD.finalized_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_crossing_publications_delete BEFORE DELETE ON budget_state WHEN (OLD.kind='publication') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_crossing_publications','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.record_id,'detected_at_ms',OLD.detected_at_ms,'materialized_at_ms',OLD.materialized_at_ms,'last_evaluated_at_ms',OLD.last_evaluated_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_group_currencies_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_group_currencies','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'group_name',OLD."group_name",'month',OLD."month",'currency',OLD."currency")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_month_caps_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_month_caps','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'budget_id',OLD."budget_id",'month',OLD."month",'cap',OLD."cap")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_month_latches_delete BEFORE DELETE ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_month_latches','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'budget_id',OLD."budget_id",'from_utc',OLD."from_utc",'time_zone',OLD."time_zone",'reached_80',OLD."reached_80",'reached_100',OLD."reached_100")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_plan_months_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_plan_months','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'month',OLD."month")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_reconciliation_work','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'occurred_at',OLD."occurred_at",'version',OLD."version",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_threshold_alerts_delete BEFORE DELETE ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_threshold_alerts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'budget_id',OLD."budget_id",'from_utc',OLD."from_utc",'time_zone',OLD."time_zone",'threshold',OLD."threshold",'state',OLD."state",'crossing_json',OLD."crossing_json",'delivery_group_id',OLD."delivery_group_id",'consent_grant_id',OLD."consent_grant_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_user_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'budget_id',OLD.budget_id,'created_at_ms',OLD.created_at_ms,'offer_requested_at_ms',OLD.offer_requested_at_ms,'first_last_evaluated_at_ms',OLD.first_last_evaluated_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budgets_delete BEFORE DELETE ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budgets','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'category_id',OLD."category_id",'currency',OLD."currency",'cap',OLD."cap",'created_at',OLD."created_at",'updated_at',OLD."updated_at",'group_name',OLD."group_name",'starts_month',OLD."starts_month")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_buckets_delete BEFORE DELETE ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_buckets','drain:'||lower(hex(randomblob(16))),json_object('subject',OLD."subject",'virtual_at_ms',OLD."virtual_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_leases_delete BEFORE DELETE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_leases','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_replays_delete BEFORE DELETE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_replays','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'operation',OLD."operation",'identity',OLD."identity",'accepted_at_ms',OLD."accepted_at_ms",'state',OLD."state",'status',OLD."status",'body',OLD."body",'content_type',OLD."content_type")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_card_enrollments_delete BEFORE DELETE ON payment_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_enrollments','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id),'price_id',OLD."price_id",'billing_email',OLD."billing_email",'status',OLD."status",'payment_source_mode',OLD."payment_source_mode",'contracts_json',OLD."contracts_json",'disclosure_json',OLD."disclosure_json",'prepared_at_ms',OLD."prepared_at_ms",'expires_at_ms',OLD."expires_at_ms",'accepted_at_ms',OLD."accepted_at_ms",'payment_request_id',OLD."payment_request_id",'wompi_candidate_source_id',OLD."wompi_candidate_source_id",'verification_attempts',OLD."verification_attempts",'last_verification_at_ms',OLD."last_verification_at_ms",'refusal_reason',OLD."refusal_reason",'method',OLD."method",'wompi_environment',OLD."wompi_environment")
  FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_commercial_allowance_consumptions_delete BEFORE DELETE ON commercial_allowance_consumptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'commercial_allowance_consumptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'allowance',OLD."allowance",'identity',OLD."identity",'period_start_ms',OLD."period_start_ms",'accepted_at_ms',OLD."accepted_at_ms",'units',OLD."units")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_connection_attempts_delete BEFORE DELETE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connection_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'institution_id',OLD."institution_id",'public_reference',OLD."public_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'consumed_at_ms',OLD."consumed_at_ms",'prepared_session_id',OLD.prepared_session_id,'prepared_at_ms',CASE WHEN OLD.prepared_session_id IS NOT NULL THEN OLD.consumed_at_ms END)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_connections_delete BEFORE DELETE ON connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connections','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'institution_id',OLD."institution_id",'state',OLD."state",'created_at_ms',OLD."created_at_ms",'updated_at_ms',OLD."updated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END,'drain:'||lower(hex(randomblob(16))),CASE OLD.record_type WHEN 'processing_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'decision_message_id',OLD."decision_message_id",'decision_received_at_ms',OLD."decision_received_at_ms",'accepted_at_ms',OLD.occurred_at_ms) WHEN 'processing_withdrawal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'processing_renewal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'withdrawal_id',OLD."withdrawal_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'disclosure_json',OLD."disclosure_json",'accepted_at_ms',OLD.occurred_at_ms) WHEN 'weekly_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'weekly_rejection' THEN json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision") WHEN 'weekly_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'proactivity_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'pat_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'pairing_id',OLD."pairing_id",'request_id',OLD."request_id",'disclosure_revision',json_extract(OLD.disclosure_json,'$.revision'),'disclosure_text',json_extract(OLD.disclosure_json,'$.text'),'accepted_at_ms',OLD.occurred_at_ms) WHEN 'pat_revocation' THEN json_object('id',OLD."id",'grant_consent_id',OLD."grant_consent_id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'pairing_id',OLD."pairing_id",'session_id',OLD."session_id",'policy_reason',OLD.reason,'disclosure_revision',json_extract(OLD.disclosure_json,'$.revision'),'disclosure_text',json_extract(OLD.disclosure_json,'$.text'),'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_grant' THEN json_object('id',OLD."id",'connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'disclosure_revision',json_extract(OLD.disclosure_json,'$.revision'),'disclosure_text',json_extract(OLD.disclosure_json,'$.text'),'accepted_at_ms',OLD.occurred_at_ms) WHEN 'oauth_replay_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'reason',OLD."reason",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_user_revocation' THEN json_object('connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'reason',OLD."reason",'disclosure_revision',json_extract(OLD.disclosure_json,'$.revision'),'disclosure_text',json_extract(OLD.disclosure_json,'$.text'),'occurred_at_ms',OLD."occurred_at_ms") END FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_dashboard_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
  FROM erasure_requests q WHERE q.state='Draining' AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_dashboard_projection_bucket_delete BEFORE DELETE ON dashboard_projection_bucket
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_bucket','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'size_seconds',OLD."size_seconds",'bucket',OLD."bucket",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'count',OLD."count",'maximum',OLD."maximum",'max_minor',OLD."max_minor")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_dashboard_projection_digit_delete BEFORE DELETE ON dashboard_projection_digit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_digit','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'size_seconds',OLD."size_seconds",'bucket',OLD."bucket",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'position',OLD."position",'digit_sum',OLD."digit_sum")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_dashboard_projection_leaf_delete BEFORE DELETE ON dashboard_projection_leaf
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_leaf','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'amount',OLD."amount",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'counterparty',OLD."counterparty",'notes',OLD."notes",'occurred_at',OLD."occurred_at",'created_at',OLD."created_at",'revision',OLD."revision")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_dashboard_projection_state_delete BEFORE DELETE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'version',OLD."version",'readiness',OLD."readiness",'cursor_id',OLD."cursor_id",'attempted_at_ms',OLD."attempted_at_ms",'fact_revision',OLD.fact_revision,'first_captured_at',OLD.first_captured_at,'time_zone',OLD.time_zone)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_receipts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'state',OLD."state",'received_at_ms',OLD."received_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'deferred_checked_at_ms',OLD."deferred_checked_at_ms",'outcome',OLD.outcome,'outcome_transaction_id',OLD.outcome_transaction_id,'outcome_review_id',OLD.outcome_review_id,'outcome_completed_at_ms',OLD.outcome_completed_at_ms,'review_id',OLD.review_id,'review_reason',OLD.review_reason,'review_created_at_ms',OLD.review_created_at_ms,'review_evidence_expires_at_ms',OLD.review_evidence_expires_at_ms,'dispatch_user_id',OLD.dispatch_user_id,'dispatch_sent_at_ms',OLD.dispatch_sent_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_agent_sessions_delete BEFORE DELETE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_agent_sessions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'consent_basis_json',OLD."consent_basis_json",'started_at_ms',OLD."started_at_ms",'last_activity_at_ms',OLD."last_activity_at_ms",'status',OLD."status",'compacted_text',OLD.compacted_text,'compacted_through_sequence',OLD.compacted_through_sequence,'compacted_revision',OLD.compacted_revision,'compacted_at_ms',OLD.compacted_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_compaction_attempts_delete BEFORE DELETE ON resource_admission_counters
WHEN (OLD.policy_key='hosted.compaction.user.v1') AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.owner_user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_compaction_attempts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."owner_user_id",'day_ms',OLD."window_start_ms",'used',OLD."used")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.owner_user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_confirmations_delete BEFORE DELETE ON hosted_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_confirmations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'issued_turn_id',OLD."issued_turn_id",'operation',OLD."operation",'input_json',OLD."input_json",'command',OLD."command",'issued_at_ms',OLD."issued_at_ms",'expires_at_ms',OLD."expires_at_ms",'consumed_turn_id',OLD."consumed_turn_id",'consumed_at_ms',OLD."consumed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_mutation_commits_delete BEFORE DELETE ON hosted_mutation_commits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_mutation_commits','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'tool_call_id',OLD."tool_call_id",'user_id',OLD."user_id",'committed_at_ms',OLD."committed_at_ms",'valid',OLD."valid")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_turns_delete BEFORE DELETE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_turns','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'started_at_ms',OLD."started_at_ms",'terminal_at_ms',OLD."terminal_at_ms",'status',OLD."status",'failure_reason',OLD."failure_reason",'proposal_user_id',CASE WHEN OLD.proposed_at_ms IS NOT NULL THEN OLD.user_id END,'proposed_at_ms',OLD.proposed_at_ms,'proposal_text',OLD.proposal_text,'retention_user_id',CASE WHEN OLD.retention_terminal_at_ms IS NOT NULL THEN OLD.user_id END,'retention_terminal_at_ms',OLD.retention_terminal_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_voice_refusals_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_voice_refusals','drain:'||lower(hex(randomblob(16))),json_object('portfolio_id',OLD."portfolio_id",'message_id',OLD."message_id",'user_id',OLD."user_id",'claimed_at_ms',OLD."claimed_at_ms",'outcome',OLD."outcome")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_whatsapp_delivery_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_delivery','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'text',OLD."text",'business_phone_number_id',OLD."business_phone_number_id",'proposed_at_ms',OLD."proposed_at_ms",'state',OLD."state",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'send_started_at_ms',OLD."send_started_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_delivery_events','drain:'||lower(hex(randomblob(16))),json_object('provider_message_id',OLD."provider_message_id",'status',OLD."status",'occurred_at_ms',OLD."occurred_at_ms",'received_at_ms',OLD."received_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_whatsapp_windows_delete BEFORE DELETE ON hosted_whatsapp_windows
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_windows','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'last_verified_inbound_at_ms',OLD."last_verified_inbound_at_ms",'closes_at_ms',OLD."closes_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_ingestion_review_state_delete BEFORE DELETE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."status",'revision',OLD."revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."expires_at_ms",'updated_at_ms',OLD."updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_ingestion_review_state_update BEFORE UPDATE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."status",'revision',OLD."revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."expires_at_ms",'updated_at_ms',OLD."updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_events','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'scheduled_at',OLD."scheduled_at",'money_groups_json',OLD."money_groups_json",'lifecycle_state',OLD."lifecycle_state")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'insight_reports','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'delivery_id',OLD.delivery_id,'role',OLD.role,'consent_grant_id',OLD.consent_grant_id,'offer_id',OLD.offer_id,'text',OLD.text,'scheduled_at_ms',OLD.scheduled_at_ms,'expires_at_ms',OLD.expires_at_ms,'time_zone',OLD.time_zone,'created_at_ms',OLD.created_at_ms,'payload_json',OLD.payload_json,'presentation_json',OLD.presentation_json,'reminder_grant_id',OLD.reminder_grant_id,'reminder_expires_at_ms',OLD.reminder_expires_at_ms,'instruction_id',OLD.instruction_id,'instruction_version',OLD.instruction_version,'grant_id',OLD.grant_id,'local_date',OLD.local_date,'day_from_ms',OLD.day_from_ms,'day_to_ms',OLD.day_to_ms,'report_json',OLD.report_json,'dispatch_state',OLD.dispatch_state,'dispatch_created_at_ms',OLD.dispatch_created_at_ms,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'dispatch_restart_attempts',OLD.dispatch_restart_attempts) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_whatsapp_claims','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'summary_json',OLD."summary_json",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'state',OLD."state",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'last_received_at_ms',OLD."last_received_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_keyword_rules_delete BEFORE DELETE ON keyword_rules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'keyword_rules','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'keyword',OLD."keyword",'normalized_keyword',OLD."normalized_keyword",'category_id',OLD."category_id",'created_at',OLD."created_at",'updated_at',OLD."updated_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_media_submissions_delete BEFORE DELETE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'message_id',OLD."message_id",'media_id',OLD."media_id",'caption',OLD."caption",'accepted_at_ms',OLD."accepted_at_ms",'expires_at_ms',OLD."expires_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'review_reason',OLD."review_reason",'review_created_at_ms',OLD."review_created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_memories_delete BEFORE DELETE ON memories
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.memory.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.memory.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'memories','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'text',OLD."text",'created_at',OLD."created_at",'updated_at',OLD."updated_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.memory.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.memory.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_pending_consent_exchanges_delete BEFORE DELETE ON pending_consent_exchanges
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'pending_consent_exchanges','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'phone_number_id',OLD."phone_number_id",'initiating_message_id',OLD."initiating_message_id",'initiating_body_sha256',OLD."initiating_body_sha256",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'created_at_ms',OLD."created_at_ms",'disclosed_at_ms',OLD."disclosed_at_ms",'decision_not_before_ms',OLD."decision_not_before_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'rejected_at_ms',OLD."rejected_at_ms",'sandbox_phone',OLD."sandbox_phone",'delivery_phone_number_id',OLD.delivery_phone_number_id,'delivery_message_id',OLD.delivery_message_id,'delivery_occurred_at_ms',OLD.delivery_occurred_at_ms,'delivery_received_at_ms',OLD.delivery_received_at_ms,'delivery_not_before_ms',OLD.delivery_not_before_ms,'decision_portfolio_id',CASE WHEN OLD.decision_value IS NOT NULL THEN OLD.portfolio_id END,'decision_bsuid',CASE WHEN OLD.decision_value IS NOT NULL THEN OLD.bsuid END,'decision_phone_number_id',CASE WHEN OLD.decision_value IS NOT NULL THEN OLD.phone_number_id END,'decision_value',OLD.decision_value,'decision_disclosure_json',CASE WHEN OLD.decision_value IS NOT NULL THEN OLD.disclosure_json END,'decision_disclosure_message_id',CASE WHEN OLD.decision_value IS NOT NULL THEN OLD.disclosure_message_id END,'decision_message_id',OLD.decision_message_id,'decision_delivery_key',OLD.decision_delivery_key,'decision_body_sha256',OLD.decision_body_sha256,'decision_occurred_at_ms',OLD.decision_occurred_at_ms,'decision_received_at_ms',OLD.decision_received_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=q.user_id AND w.portfolio_id=OLD.portfolio_id AND w.bsuid=OLD.bsuid))
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactive_transcript_entries_delete BEFORE DELETE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'delivery_id',OLD.delivery_id,'role',OLD.role,'sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete BEFORE DELETE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('transcript_kind',OLD.transcript_kind,'user_id',OLD.user_id,'transcript_id',OLD.transcript_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete_clear BEFORE UPDATE ON insight_events WHEN (OLD.transcript_id IS NOT NULL) AND NEW.transcript_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('transcript_kind',OLD.transcript_kind,'user_id',OLD.user_id,'transcript_id',OLD.transcript_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_consent_offers','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'disclosure_json',OLD."disclosure_json",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'disclosure_message_id',OLD."disclosure_message_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'replaces_offer_id',OLD."replaces_offer_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete BEFORE DELETE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete_clear BEFORE UPDATE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND NEW.report_delivery_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_offer_requests_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_offer_requests','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'kind',OLD.request_kind,'request_message_id',OLD.request_message_id,'created_at_ms',OLD.created_at_ms,'materialized_at_ms',OLD.materialized_at_ms,'last_evaluated_at_ms',OLD.last_evaluated_at_ms,'delivery_id',OLD.offer_delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_whatsapp_claims','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'role',OLD."role",'consent_grant_id',OLD."consent_grant_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'template_json',OLD."template_json",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'state',OLD."state",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.disposition IS NULL AND OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_days_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_days','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'local_date',OLD."local_date",'day_from_ms',OLD."day_from_ms",'day_to_ms',OLD."day_to_ms",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_instructions_delete BEFORE DELETE ON schedules
WHEN OLD.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_instructions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'version',OLD."version",'enabled',OLD."enabled",'grant_id',OLD.consent_grant_id,'context_json',OLD.snapshot_json,'acceptance_from_ms',OLD."acceptance_from_ms",'accepted_at_ms',OLD."accepted_at_ms",'last_source_identity',OLD."last_source_identity",'next_closed_at_ms',OLD."next_closed_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms",'source_checkpoint',OLD.source_checkpoint,'source_cursor',OLD.source_cursor,'source_cutoff_at_ms',OLD.source_cutoff_at_ms,'source_complete',OLD.source_complete)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.confirmed_at_ms IS NULL AND OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_dispatch_delete BEFORE DELETE ON recurring_dispatch
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.last_user=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_dispatch','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'last_user',OLD."last_user",'next_discovery_at_ms',OLD."next_discovery_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.last_user=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_facts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'group_key',OLD."group_key",'occurred_at',OLD."occurred_at",'fact_json',OLD."fact_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_plan_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id AND OLD.kind='recurring-plan')
AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'recurring_plan_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id AND OLD.kind='recurring-plan')
 AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_progress_delete BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_progress','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'phase',OLD."phase",'cursor_at',OLD."cursor_at",'cursor_id',OLD."cursor_id",'group_key',OLD."group_key",'evaluated_at',OLD."evaluated_at",'evaluated_revision',OLD."evaluated_revision",'first_captured_at',OLD."first_captured_at",'time_zone',OLD."time_zone")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_proposals','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'proposal_key',OLD.id,'proposal_json',OLD."proposal_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_series_delete BEFORE DELETE ON recurring_series
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_series','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'currency',OLD."currency",'counterparty_key',OLD."counterparty_key",'series_json',OLD."series_json",'evidence_json',OLD."evidence_json",'reference_json',OLD."reference_json",'valid',OLD."valid")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM refund_attempt_context r,erasure_requests q WHERE r.rowid=OLD.rowid AND q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'subscription_id',r."subscription_id",'billing_attempt_id',OLD."billing_attempt_id",'transaction_id',OLD."transaction_id",'request_id',OLD."request_id",'intent_json',OLD."intent_json",'treatment_json',OLD."treatment_json",'amount_in_cents',OLD."amount_in_cents",'original_cents',r."original_cents",'kind',OLD."kind",'operator_id',OLD."operator_id",'created_at_ms',OLD."created_at_ms",'status',OLD."status",'progress',OLD."progress",'finalized_at_ms',OLD."finalized_at_ms",'failure',OLD."failure",'work_version',CASE WHEN OLD.verification_attempts IS NOT NULL THEN 1 END,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'verification_attempts',OLD.verification_attempts,'last_verification_at_ms',OLD.last_verification_at_ms,'submission_claimed_at_ms',OLD.submission_claimed_at_ms,'provider_refund_id',OLD.provider_refund_id,'verified_status',OLD.verified_status,'observed_at_ms',OLD.observed_at_ms,'adjusted_attempt_id',r.adjusted_attempt_id,'access_ends_at_ms',OLD.access_ends_at_ms,'renewal_stopped_user_id',r.renewal_stopped_user_id,'renewal_stopped_at_ms',OLD.renewal_stopped_at_ms)
  FROM refund_attempt_context r,erasure_requests q WHERE r.rowid=OLD.rowid AND q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_reminder_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'standing_json',OLD."standing_json",'last_reply_at_ms',OLD."last_reply_at_ms",'question_id',OLD."question_id",'question_delivered_at_ms',OLD."question_delivered_at_ms",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_resource_admission_events_delete BEFORE DELETE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.policy_key<>'pat.review.session.v1' AND OLD.scope_key=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'resource_admission_events','drain:'||lower(hex(randomblob(16))),json_object('grant_id',OLD."grant_id",'policy_key',OLD."policy_key",'dimension',OLD."dimension",'scope_key',OLD."scope_key",'policy_kind',OLD."policy_kind",'units',OLD."units",'admitted_at_epoch_ms',OLD."admitted_at_epoch_ms",'window_start_epoch_ms',OLD."window_start_epoch_ms",'expires_at_epoch_ms',OLD."expires_at_epoch_ms",'released_at_epoch_ms',OLD."released_at_epoch_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.policy_key<>'pat.review.session.v1' AND OLD.scope_key=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedule_executions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_executions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'schedule_version',OLD.version,'scheduled_at',OLD.scheduled_at,'outcome',OLD.outcome) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedule_revisions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_revisions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'version',OLD.version,'snapshot_json',OLD.snapshot_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedules_delete BEFORE DELETE ON schedules
WHEN OLD.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedules','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'id',OLD.id,'user_id',OLD.user_id,'version',OLD.version,'enabled',OLD.enabled,'snapshot_json',OLD.snapshot_json,'next_scheduled_at',OLD.next_scheduled_at,'consent_grant_id',OLD.consent_grant_id,'last_evaluated_at_ms',OLD.last_evaluated_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
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

CREATE TRIGGER erasure_preserve_statement_materialization_parts_delete BEFORE DELETE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_materialization_parts','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'chunk_index',OLD."chunk_index",'part_index',OLD."part_index",'body',OLD."body",'sha256',OLD."sha256")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_statement_needs_review_delete BEFORE DELETE ON ingestion_review_items
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_needs_review','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'submission_id',OLD."statement_submission_id",'record_number',OLD."record_number",'reason',OLD."reason",'original_evidence',OLD."original_evidence",'known_money',OLD."known_money_json",'issues',OLD."issues_json",'status',CASE OLD.evidence_state WHEN 'retained' THEN 'pending' ELSE OLD.evidence_state END,'evidence_expires_at_ms',OLD."evidence_expires_at_ms",'created_at_ms',OLD."created_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'extractor_revision',OLD."extractor_revision",'review_suggestions_json',OLD."suggestions_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_statement_record_outcomes_delete BEFORE DELETE ON statement_record_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_record_outcomes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'submission_id',OLD."submission_id",'record_number',OLD."record_number",'outcome',OLD."outcome",'transaction_id',OLD."transaction_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_statement_staging_objects_delete BEFORE DELETE ON statement_staging_objects
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_staging_objects','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'sha256',OLD."sha256",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'published_submission_id',OLD."published_submission_id",'source_format',OLD."source_format",'object_deleted_at_ms',OLD."object_deleted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows",'hosted_session_id',OLD.hosted_session_id,'hosted_turn_id',OLD.hosted_turn_id,'hosted_expires_at_ms',OLD.hosted_expires_at_ms,'hosted_abandoned_at_ms',OLD.hosted_abandoned_at_ms,'clarification_state',OLD.clarification_state,'clarification_expires_at_ms',OLD.clarification_expires_at_ms,'clarification_ended_at_ms',OLD.clarification_ended_at_ms,'work_user_id',CASE WHEN OLD.work_published_at_ms IS NOT NULL THEN OLD.user_id END,'work_revision',CASE WHEN OLD.work_published_at_ms IS NOT NULL THEN 1 END,'work_published_at_ms',OLD.work_published_at_ms,'work_last_attempt_at_ms',OLD.work_last_attempt_at_ms,'work_last_reconciled_at_ms',OLD.work_last_reconciled_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscription_cancellations_delete BEFORE DELETE ON subscription_cancellations
WHEN OLD.cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_cancellations','drain:'||lower(hex(randomblob(16))),json_object('user_id',(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id),'paid_attempt_id',OLD.paid_attempt_id,'payment_source_id',OLD.payment_source_id,'cancelled_at_ms',OLD.cancelled_at_ms,'paid_through_ms',OLD.paid_through_ms,'source_cancellation',OLD.source_cancellation_state,'void_started_at_ms',OLD.void_started_at_ms,'void_verified_at_ms',OLD.void_verified_at_ms,'verification_count',OLD.verification_count,'last_offered_at_ms',OLD.last_offered_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscriptions_delete BEFORE DELETE ON subscriptions WHEN (OLD.current_paid_attempt_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscriptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'attempt_id',OLD.current_paid_attempt_id,'price_id',(SELECT price_id FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id),'paid_period_ends_at_ms',(SELECT paid_ends_at_ms FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id),'renewal_anchor_ms',(SELECT paid_renewal_anchor_ms FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id))
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscriptions_delete_clear BEFORE UPDATE ON subscriptions WHEN (OLD.current_paid_attempt_id IS NOT NULL) AND NEW.current_paid_attempt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscriptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'attempt_id',OLD.current_paid_attempt_id,'price_id',(SELECT price_id FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id),'paid_period_ends_at_ms',(SELECT paid_ends_at_ms FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id),'renewal_anchor_ms',(SELECT paid_renewal_anchor_ms FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id))
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
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

CREATE TRIGGER erasure_preserve_transaction_reconciliation_decisions_delete BEFORE DELETE ON transaction_reconciliation_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_reconciliation_decisions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'first_transaction_id',OLD."first_transaction_id",'second_transaction_id',OLD."second_transaction_id",'state',OLD."state",'visible_transaction_id',OLD."visible_transaction_id",'decided_at',OLD."decided_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
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

CREATE TRIGGER erasure_preserve_transcript_entries_delete BEFORE DELETE ON transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'turn_id',OLD."turn_id",'kind',OLD."kind",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'failure_reason',OLD."failure_reason",'iteration',OLD."iteration",'tool_call_id',OLD."tool_call_id",'operation',OLD."operation",'input_json',OLD."input_json",'outcome_json',OLD."outcome_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_consent_offers','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'disclosure_json',OLD."disclosure_json",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'disclosure_message_id',OLD."disclosure_message_id",'disclosed_at_ms',OLD."disclosed_at_ms",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'source_id',OLD."source_id",'rejection_id',OLD."rejection_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_governor_questions_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_questions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'grant_id',OLD."grant_id",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'text',OLD."text",'offer_json',OLD."offer_json",'time_zone',OLD."time_zone",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'unanswered',OLD."unanswered",'last_reply_at_ms',OLD."last_reply_at_ms",'question_needed',OLD."question_needed",'question_delivered',OLD."question_delivered",'question_delivered_at_ms',OLD."question_delivered_at_ms",'question_event_id',OLD."question_event_id",'paused_at_ms',OLD."paused_at_ms",'notice_session_id',OLD."notice_session_id",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_question_intents_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_question_intents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'origin',OLD.origin,'request_message_id',OLD.request_message_id,'rejection_offer_id',OLD.rejection_offer_id,'state',OLD.dispatch_state,'created_at_ms',OLD.created_at_ms,'last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'restart_attempts',OLD.dispatch_restart_attempts)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_capacity BEFORE INSERT ON forwarded_email_receipts
WHEN (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.expires_at_ms > NEW.received_at_ms AND r.outcome IS NULL) >= 1000
  OR (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.user_id = NEW.user_id AND r.expires_at_ms > NEW.received_at_ms AND r.outcome IS NULL) >= 100
  OR (SELECT count(*) FROM forwarded_email_receipts r WHERE r.user_id = NEW.user_id
    AND r.received_at_ms > NEW.received_at_ms - 7776000000) >= 1000
  OR (SELECT count(*) FROM forwarded_email_receipts r
    WHERE r.received_at_ms > NEW.received_at_ms - 7776000000) >= 10000
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_capacity');
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

CREATE TRIGGER forwarded_email_completed_no_delete BEFORE DELETE ON forwarded_email_receipts
WHEN (OLD.outcome IS NOT NULL OR OLD.review_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='forwarded_email_receipts' AND p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing')
BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_completion_initial BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.outcome IS NOT NULL OR NEW.review_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_deferred_capacity_insert BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN
 SELECT RAISE(ABORT,'forwarded_email_deferred_capacity');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_deferred_capacity_update BEFORE UPDATE OF deferred_checked_at_ms ON forwarded_email_receipts
WHEN OLD.deferred_checked_at_ms IS NULL AND NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN
 SELECT RAISE(ABORT,'forwarded_email_deferred_capacity');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_deferred_expiry AFTER UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state='expired' AND NEW.deferred_checked_at_ms IS NOT NULL
BEGIN
 UPDATE forwarded_email_receipts SET deferred_checked_at_ms=NULL WHERE id=NEW.id AND user_id=NEW.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_outcome_consent BEFORE UPDATE OF outcome ON forwarded_email_receipts
WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND ((NEW.outcome <> 'needs-review' OR NOT (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.outcome_completed_at_ms)))
  OR ((NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.outcome_completed_at_ms OR (NEW.outcome = 'needs-review'
        AND (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason IN ('processing-interrupted','consent-revoked')))))
)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_authority');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_outcome_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.outcome IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.outcome IS NOT OLD.outcome OR NEW.outcome_transaction_id IS NOT OLD.outcome_transaction_id OR NEW.outcome_review_id IS NOT OLD.outcome_review_id OR NEW.outcome_completed_at_ms IS NOT OLD.outcome_completed_at_ms) BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_receipts_companions_initial BEFORE INSERT ON forwarded_email_receipts WHEN NEW.dispatch_user_id IS NOT NULL OR NEW.dispatch_sent_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'forwarded_email_receipts_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER forwarded_email_review_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.review_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.review_id IS NOT OLD.review_id OR NEW.review_reason IS NOT OLD.review_reason OR NEW.review_created_at_ms IS NOT OLD.review_created_at_ms OR NEW.review_evidence_expires_at_ms IS NOT OLD.review_evidence_expires_at_ms) BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_agent_sessions_companions_initial BEFORE INSERT ON hosted_agent_sessions WHEN NEW.compacted_text IS NOT NULL OR NEW.compacted_through_sequence IS NOT NULL OR NEW.compacted_revision IS NOT NULL OR NEW.compacted_nonce IS NOT NULL OR NEW.compacted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'hosted_agent_sessions_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_confirmations_consume_once BEFORE UPDATE ON hosted_confirmations
WHEN OLD.consumed_turn_id IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.issued_turn_id <> OLD.issued_turn_id OR NEW.operation <> OLD.operation
  OR NEW.input_json <> OLD.input_json OR NEW.command <> OLD.command
  OR NEW.issued_at_ms <> OLD.issued_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
  OR NEW.consumed_turn_id IS NULL OR NEW.consumed_at_ms IS NULL
BEGIN SELECT RAISE(ABORT, 'hosted_confirmation_consume_once'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_confirmations_no_delete_active BEFORE DELETE ON hosted_confirmations
WHEN (OLD.expires_at_ms >= unixepoch('now') * 1000) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='hosted_confirmations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'hosted_confirmation_retention_not_due'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_delivery_proposals_no_update BEFORE UPDATE OF proposal_receipt_digest,proposed_at_ms,proposal_text ON hosted_turns
WHEN OLD.proposed_at_ms IS NOT NULL AND (NEW.proposal_receipt_digest IS NOT OLD.proposal_receipt_digest OR NEW.proposed_at_ms IS NOT OLD.proposed_at_ms OR NEW.proposal_text IS NOT OLD.proposal_text) AND NEW.proposed_at_ms IS NOT NULL AND (NEW.id <> OLD.id OR NEW.proposal_text <> OLD.proposal_text
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.id
    AND user_id = OLD.user_id AND status = 'pending'))
BEGIN
 SELECT RAISE(ABORT, 'hosted_delivery_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_inbound_dispatch_initial BEFORE UPDATE ON hosted_turns
WHEN OLD.inbound_message_id IS NULL AND NEW.inbound_message_id IS NOT NULL
 AND (NEW.dispatch_offered_at_ms IS NOT NULL OR NEW.dispatch_created_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'hosted_whatsapp_inbound_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_channel_append AFTER UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NULL AND NEW.inbound_message_id IS NOT NULL
BEGIN
 UPDATE hosted_turns SET retention_terminal_at_ms=terminal_at_ms WHERE id=NEW.id AND user_id=NEW.user_id AND status<>'pending' AND retention_terminal_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_channel_remove AFTER UPDATE ON hosted_turns
WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NULL AND (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_whatsapp_inbound' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.id AND user_id = OLD.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_mutation_append AFTER INSERT ON hosted_mutation_commits
BEGIN
 UPDATE hosted_turns SET retention_terminal_at_ms=terminal_at_ms WHERE id=NEW.turn_id AND user_id=NEW.user_id AND status<>'pending' AND retention_terminal_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_mutation_remove AFTER DELETE ON hosted_mutation_commits
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_mutation_commits' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND user_id = OLD.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_transcript_append AFTER INSERT ON transcript_entries
BEGIN
 UPDATE hosted_turns SET retention_terminal_at_ms=terminal_at_ms WHERE id=NEW.turn_id AND user_id=NEW.user_id AND status<>'pending' AND retention_terminal_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_retention_transcript_remove AFTER DELETE ON transcript_entries
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transcript_entries' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND user_id = OLD.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turn_daily_budget BEFORE INSERT ON hosted_turns
WHEN (SELECT COUNT(*) FROM hosted_turns WHERE user_id = NEW.user_id
      AND started_at_ms >= (NEW.started_at_ms / 86400000) * 86400000
      AND started_at_ms < ((NEW.started_at_ms / 86400000) + 1) * 86400000) >= 50
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_daily_budget');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_consent_required');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turn_retention_terminal AFTER UPDATE ON hosted_turns
WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
BEGIN
 UPDATE hosted_turns SET retention_terminal_at_ms=NEW.terminal_at_ms WHERE id=NEW.id AND user_id=NEW.user_id AND retention_terminal_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turns_begin_pending BEFORE INSERT ON hosted_turns
WHEN NEW.status <> 'pending'
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_must_begin_pending');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turns_companions_initial BEFORE INSERT ON hosted_turns WHEN NEW.proposal_receipt_digest IS NOT NULL OR NEW.proposed_at_ms IS NOT NULL OR NEW.proposal_text IS NOT NULL OR NEW.retention_terminal_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'hosted_turns_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE OF status,terminal_at_ms,failure_reason ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM (SELECT rowid,id AS turn_id,user_id AS user_id,proposal_receipt_digest AS receipt_digest,proposed_at_ms,proposal_text AS text FROM hosted_turns WHERE proposed_at_ms IS NOT NULL) AS hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_turns_terminal_once BEFORE UPDATE OF id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason ON hosted_turns
WHEN OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.hosted_session_id <> OLD.hosted_session_id OR NEW.started_at_ms <> OLD.started_at_ms
  OR NEW.status = 'pending'
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_terminal_once');
END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_delivery_event_immutable BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='delivery-status' OR NEW.kind='delivery-status') BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_event_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_delivery_identity_immutable BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.correlation_token <> OLD.correlation_token
  OR NEW.business_phone_number_id <> OLD.business_phone_number_id
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
  OR OLD.state IN ('rejected','delivered','unconfirmed')
)
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_delivery_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_delete BEFORE DELETE ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_insert BEFORE INSERT ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_update BEFORE UPDATE ON hosted_turns WHEN (NEW.inbound_portfolio_id IS NOT OLD.inbound_portfolio_id OR NEW.inbound_bsuid IS NOT OLD.inbound_bsuid OR NEW.inbound_message_id IS NOT OLD.inbound_message_id OR NEW.inbound_business_phone_number_id IS NOT OLD.inbound_business_phone_number_id OR NEW.inbound_occurred_at_ms IS NOT OLD.inbound_occurred_at_ms OR NEW.inbound_received_at_ms IS NOT OLD.inbound_received_at_ms OR NEW.inbound_reply_to_message_id IS NOT OLD.inbound_reply_to_message_id OR NEW.inbound_sandbox_phone IS NOT OLD.inbound_sandbox_phone OR NEW.dispatch_offered_at_ms IS NOT OLD.dispatch_offered_at_ms OR NEW.dispatch_created_at_ms IS NOT OLD.dispatch_created_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_delete BEFORE DELETE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',CASE WHEN OLD.dispatch_created_at_ms IS NOT NULL THEN OLD.user_id END,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_update BEFORE UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',CASE WHEN OLD.dispatch_created_at_ms IS NOT NULL THEN OLD.user_id END,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_immutable BEFORE UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.inbound_portfolio_id IS NOT OLD.inbound_portfolio_id OR NEW.inbound_bsuid IS NOT OLD.inbound_bsuid OR NEW.inbound_message_id IS NOT OLD.inbound_message_id OR NEW.inbound_business_phone_number_id IS NOT OLD.inbound_business_phone_number_id OR NEW.inbound_occurred_at_ms IS NOT OLD.inbound_occurred_at_ms OR NEW.inbound_received_at_ms IS NOT OLD.inbound_received_at_ms OR NEW.inbound_reply_to_message_id IS NOT OLD.inbound_reply_to_message_id OR NEW.inbound_sandbox_phone IS NOT OLD.inbound_sandbox_phone) BEGIN SELECT RAISE(ABORT,'hosted_whatsapp_inbound_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_delete BEFORE DELETE ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_insert BEFORE INSERT ON insight_events WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_fence_update BEFORE UPDATE ON insight_events WHEN (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.delivery_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_delivery_attempts'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NEW.delivery_receipt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_receipt_immutable BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND (NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id) AND NOT((NEW.delivery_receipt_id IS NULL AND NEW.delivery_sent_at IS NULL AND NEW.delivery_channel IS NULL AND NEW.delivery_provider IS NULL AND NEW.delivery_provider_message_id IS NULL) AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_receipt_no_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_delivery_attempts' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing')) BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed')
    OR (NEW.lifecycle_state=OLD.lifecycle_state AND ((NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) OR NEW.report_delivery_id IS NOT OLD.report_delivery_id OR NEW.transcript_id IS NOT OLD.transcript_id OR NEW.transcript_kind IS NOT OLD.transcript_kind OR NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id OR NEW.weekly_governor_counted IS NOT OLD.weekly_governor_counted)))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER insight_reports_immutable BEFORE UPDATE ON insight_reports WHEN (OLD.kind IN ('weekly-summary','proactivity-delivery') OR NEW.kind IN ('weekly-summary','proactivity-delivery')) AND (NOT(NEW.kind IS OLD.kind AND NEW.user_id IS OLD.user_id AND NEW.delivery_id IS OLD.delivery_id AND NEW.role IS OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms IS OLD.scheduled_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.payload_json IS OLD.payload_json AND NEW.presentation_json IS OLD.presentation_json AND NEW.reminder_grant_id IS OLD.reminder_grant_id AND NEW.reminder_expires_at_ms IS OLD.reminder_expires_at_ms AND NEW.instruction_id IS OLD.instruction_id AND NEW.instruction_version IS OLD.instruction_version AND NEW.grant_id IS OLD.grant_id AND NEW.local_date IS OLD.local_date AND NEW.day_from_ms IS OLD.day_from_ms AND NEW.day_to_ms IS OLD.day_to_ms AND NEW.report_json IS OLD.report_json AND (NEW.text IS OLD.text OR (OLD.kind='proactivity-delivery' AND OLD.text IS NOT NULL AND NEW.text IS NULL)))) BEGIN SELECT RAISE(ABORT,'insight_report_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER insight_reports_no_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_reports' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN
 SELECT RAISE(ABORT,'insight_report_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_claim_identity BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (NEW.user_id <> OLD.user_id OR NEW.insight_event_id <> OLD.insight_event_id
 OR NEW.correlation_token <> OLD.correlation_token OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.business_phone_number_id <> OLD.business_phone_number_id
 OR NEW.scheduled_at_ms <> OLD.scheduled_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR NEW.time_zone <> OLD.time_zone
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
 OR (OLD.state <> 'staged' AND NEW.state IN ('staged','expired'))
 OR (OLD.state = 'delivered' AND NEW.state <> 'delivered')
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.summary_json IS NOT NULL AND NEW.summary_json IS NOT OLD.summary_json)
)
BEGIN SELECT RAISE(ABORT,'insight_claim_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_routes_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_routes_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_routes_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.route_portfolio_id IS NOT OLD.route_portfolio_id OR NEW.route_bsuid IS NOT OLD.route_bsuid OR NEW.route_phone_number_id IS NOT OLD.route_phone_number_id OR NEW.route_verified_at_ms IS NOT OLD.route_verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.route_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_routes'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_routes_field_preserve_delete BEFORE DELETE ON users WHEN OLD.route_portfolio_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_whatsapp_routes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'portfolio_id',OLD.route_portfolio_id,'bsuid',OLD.route_bsuid,'business_phone_number_id',OLD.route_phone_number_id,'verified_at_ms',OLD.route_verified_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_whatsapp_routes_field_preserve_update BEFORE UPDATE ON users WHEN OLD.route_portfolio_id IS NOT NULL AND NEW.route_portfolio_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_whatsapp_routes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'portfolio_id',OLD.route_portfolio_id,'bsuid',OLD.route_bsuid,'business_phone_number_id',OLD.route_phone_number_id,'verified_at_ms',OLD.route_verified_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_work_identity_immutable BEFORE UPDATE ON insight_reports WHEN (NEW.kind IS NOT OLD.kind OR NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id) BEGIN SELECT RAISE(ABORT,'insight_work_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER issue_forwarding_address AFTER INSERT ON consent_history WHEN NEW.record_type='processing_grant' BEGIN INSERT INTO forwarding_addresses(id,user_id,local_part,issued_at_ms) SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-8' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),NEW.user_id,lower(hex(randomblob(24))),NEW.occurred_at_ms WHERE NOT EXISTS(SELECT 1 FROM forwarding_addresses WHERE user_id=NEW.user_id); END;
--> statement-breakpoint

CREATE TRIGGER keyword_rule_capacity BEFORE INSERT ON keyword_rules
WHEN (SELECT COUNT(*) FROM keyword_rules WHERE user_id = NEW.user_id) >= 100
BEGIN SELECT RAISE(ABORT, 'keyword_rule_limit'); END;
--> statement-breakpoint

CREATE TRIGGER linked_transaction_no_delete BEFORE UPDATE OF deleted_at_ms ON transactions
WHEN NEW.deleted_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM reconciled_transactions WHERE user_id = OLD.user_id AND transaction_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'transaction_linked'); END;
--> statement-breakpoint

CREATE TRIGGER memory_capacity_before_insert BEFORE INSERT ON memories
WHEN (SELECT COALESCE(SUM(length(CAST(json_object('id', id, 'text', text) AS BLOB))), 0)
        FROM memories WHERE user_id = NEW.user_id)
   + length(CAST(json_object('id', NEW.id, 'text', NEW.text) AS BLOB))
   + (SELECT COUNT(*) FROM memories WHERE user_id = NEW.user_id) > 15000
BEGIN SELECT RAISE(ABORT, 'memory_capacity_exceeded'); END;
--> statement-breakpoint

CREATE TRIGGER memory_capacity_before_revision BEFORE UPDATE OF text ON memories
WHEN (SELECT COALESCE(SUM(length(CAST(json_object('id', id, 'text', text) AS BLOB))), 0)
        FROM memories WHERE user_id = NEW.user_id AND id <> NEW.id)
   + length(CAST(json_object('id', NEW.id, 'text', NEW.text) AS BLOB))
   + (SELECT COUNT(*) FROM memories WHERE user_id = NEW.user_id) - 1 > 15000
BEGIN SELECT RAISE(ABORT, 'memory_capacity_exceeded'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_connection_immutable BEFORE UPDATE OF user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms ON oauth_connections
BEGIN
 SELECT RAISE(ABORT,'oauth_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER oauth_connections_companions_initial BEFORE INSERT ON oauth_connections WHEN NEW.code_digest IS NOT NULL OR NEW.code_challenge IS NOT NULL OR NEW.code_expires_at_ms IS NOT NULL OR NEW.code_consumed_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'oauth_connections_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_credential_kind_immutable BEFORE UPDATE OF kind ON oauth_credentials WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'oauth_credential_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_operation_intents_capacity BEFORE INSERT ON oauth_operation_intents
WHEN (SELECT count(*) FROM oauth_operation_intents WHERE user_id = NEW.user_id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'oauth_confirmation_capacity');
END;
--> statement-breakpoint

CREATE TRIGGER oauth_refresh_policy_immutable BEFORE UPDATE OF refresh_allowed ON oauth_connections
BEGIN
 SELECT RAISE(ABORT,'oauth_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER oauth_refresh_subject BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='refresh' AND (NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM oauth_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id)
) BEGIN
 SELECT RAISE(ABORT,'oauth_subject');
END;
--> statement-breakpoint

CREATE TRIGGER oauth_registry_capacity BEFORE INSERT ON oauth_public_clients
WHEN (SELECT count(*) FROM oauth_public_clients) >= 10000
BEGIN SELECT RAISE(ABORT, 'oauth_capacity'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_source_capacity BEFORE INSERT ON oauth_review_requests
WHEN (SELECT count(*) FROM oauth_review_requests WHERE source_digest = NEW.source_digest AND state = 'pending' AND expires_at_ms > NEW.created_at_ms) >= 5
BEGIN SELECT RAISE(ABORT, 'oauth_capacity'); END;
--> statement-breakpoint

CREATE TRIGGER paired_pat_requires_claim BEFORE INSERT ON pats
WHEN NEW.pairing_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE id = NEW.pairing_id AND user_id = NEW.user_id
    AND state = 'claimed' AND expires_at_ms > NEW.issued_at_ms
    AND approved_at_ms = NEW.created_at_ms AND approved_at_ms <= NEW.issued_at_ms
    AND pat_expires_at_ms = NEW.expires_at_ms AND pat_expires_at_ms > NEW.issued_at_ms
    AND recipient_label = NEW.recipient_label AND scopes_json = NEW.scopes_json
    AND lifetime_days = NEW.lifetime_days
)
BEGIN SELECT RAISE(ABORT,'pat_pairing_not_claimable'); END;
--> statement-breakpoint

CREATE TRIGGER pairing_email_erasure_delete BEFORE DELETE ON browser_login_pairings WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER pairing_email_erasure_update BEFORE UPDATE OF email_work_id,email_user_id,email_address,email_credential_verified_at_ms,email_state,email_public_code,email_proof_digest,email_proof_expires_at_ms,email_expires_at_ms,email_generation,email_wrong_attempts,email_last_requested_at_ms,email_dispatch_attempted_at_ms ON browser_login_pairings WHEN (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.email_user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER payment_attempt_method_guard BEFORE INSERT ON billing_attempts
WHEN NOT EXISTS (SELECT 1 FROM payment_enrollment_context AS e
  JOIN payment_source_context AS s ON s.id = NEW.payment_source_id AND s.user_id = e.user_id
  JOIN payment_enrollment_context AS origin ON origin.id = s.enrollment_id
  WHERE e.id = NEW.enrollment_id AND e.user_id = (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id) AND e.method = s.method
    AND (e.wompi_environment = NEW.wompi_environment OR (e.wompi_environment IS NULL AND e.method = 'card'))
    AND (origin.wompi_environment = NEW.wompi_environment OR (origin.wompi_environment IS NULL AND origin.method = 'card'))
    AND NOT EXISTS (SELECT 1 FROM billing_attempt_context AS prior
      WHERE prior.payment_source_id = s.id AND prior.wompi_environment <> NEW.wompi_environment))
BEGIN
 SELECT RAISE(ABORT, 'payment_attempt_method_mismatch');
END;
--> statement-breakpoint

CREATE TRIGGER payment_enrollment_method_immutable BEFORE UPDATE ON payment_enrollments
WHEN NEW.method <> OLD.method OR NEW.wompi_environment IS NOT OLD.wompi_environment
  OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS NOT OLD.authorization_digest)
BEGIN SELECT RAISE(ABORT, 'payment_enrollment_method_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_exchange_basis_immutable BEFORE UPDATE ON pending_consent_exchanges
WHEN NEW.id IS NOT OLD.id OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.bsuid IS NOT OLD.bsuid
 OR NEW.phone_number_id IS NOT OLD.phone_number_id OR NEW.disclosure_json IS NOT OLD.disclosure_json
 OR ((OLD.decision_value IS NOT NULL OR OLD.disclosure_message_id IS NOT NULL)
   AND NEW.disclosure_message_id IS NOT OLD.disclosure_message_id)
BEGIN SELECT RAISE(ABORT,'pending_consent_exchange_basis_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decision_requires_delivery BEFORE UPDATE OF decision_value,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NULL AND NEW.decision_value IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e
  WHERE e.id = NEW.id AND e.state = 'awaiting_decision' AND e.disclosure_message_id IS NOT NULL
    AND NEW.decision_message_id <> e.initiating_message_id
    -- Kapso timestamps have second precision: equal timestamps cannot prove reply order.
    AND NEW.decision_occurred_at_ms > e.disclosed_at_ms AND NEW.decision_occurred_at_ms > e.decision_not_before_ms
    AND NEW.decision_occurred_at_ms < e.expires_at_ms
    AND NEW.decision_received_at_ms < e.expires_at_ms
))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_invalid_decision');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decision_settles AFTER UPDATE OF decision_value,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NULL AND NEW.decision_value IS NOT NULL
BEGIN
 UPDATE pending_consent_exchanges SET state = NEW.decision_value WHERE id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_decisions_no_update BEFORE UPDATE OF decision_value,decision_message_id,decision_delivery_key,decision_body_sha256,decision_occurred_at_ms,decision_received_at_ms ON pending_consent_exchanges
WHEN OLD.decision_value IS NOT NULL AND (NEW.decision_value IS NOT OLD.decision_value OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision_delivery_key IS NOT OLD.decision_delivery_key OR NEW.decision_body_sha256 IS NOT OLD.decision_body_sha256 OR NEW.decision_occurred_at_ms IS NOT OLD.decision_occurred_at_ms OR NEW.decision_received_at_ms IS NOT OLD.decision_received_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_delivery_no_update BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NOT NULL AND (NEW.delivery_phone_number_id IS NOT OLD.delivery_phone_number_id OR NEW.delivery_message_id IS NOT OLD.delivery_message_id OR NEW.delivery_occurred_at_ms IS NOT OLD.delivery_occurred_at_ms OR NEW.delivery_received_at_ms IS NOT OLD.delivery_received_at_ms OR NEW.delivery_not_before_ms IS NOT OLD.delivery_not_before_ms) AND NEW.delivery_message_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_append_only');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_delivery_opens_decision AFTER UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL
BEGIN
 UPDATE pending_consent_exchanges SET state = 'awaiting_decision', disclosed_at_ms = NEW.delivery_occurred_at_ms,
    decision_not_before_ms = NEW.delivery_not_before_ms,
    disclosure_message_id = NEW.delivery_message_id WHERE correlation_token = NEW.correlation_token;
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_delivery_requires_attempt BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM pending_consent_exchanges AS e WHERE e.correlation_token = NEW.correlation_token
    AND e.state = 'outbound_started' AND e.phone_number_id = NEW.delivery_phone_number_id
    AND (e.disclosure_message_id IS NULL OR e.disclosure_message_id = NEW.delivery_message_id)
    AND NEW.delivery_occurred_at_ms >= (e.created_at_ms / 1000) * 1000 AND NEW.delivery_occurred_at_ms < e.expires_at_ms
    AND NEW.delivery_received_at_ms < e.expires_at_ms
))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_invalid_delivery');
END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_exchanges_companions_initial BEFORE INSERT ON pending_consent_exchanges WHEN NEW.delivery_phone_number_id IS NOT NULL OR NEW.delivery_message_id IS NOT NULL OR NEW.delivery_occurred_at_ms IS NOT NULL OR NEW.delivery_received_at_ms IS NOT NULL OR NEW.delivery_not_before_ms IS NOT NULL OR NEW.decision_value IS NOT NULL OR NEW.decision_message_id IS NOT NULL OR NEW.decision_delivery_key IS NOT NULL OR NEW.decision_body_sha256 IS NOT NULL OR NEW.decision_occurred_at_ms IS NOT NULL OR NEW.decision_received_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'pending_consent_exchanges_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER pending_consent_rejected_delivery BEFORE UPDATE OF delivery_phone_number_id,delivery_message_id,delivery_occurred_at_ms,delivery_received_at_ms,delivery_not_before_ms ON pending_consent_exchanges
WHEN OLD.delivery_message_id IS NULL AND NEW.delivery_message_id IS NOT NULL AND (EXISTS (SELECT 1 FROM pending_consent_exchanges
  WHERE correlation_token = NEW.correlation_token AND rejected_at_ms IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT, 'pending_consent_rejected_delivery');
END;
--> statement-breakpoint

CREATE TRIGGER proactive_primary_link AFTER INSERT ON proactive_transcript_entries WHEN NEW.kind='insight' BEGIN UPDATE insight_events SET transcript_id=NEW.id,transcript_kind='insight' WHERE user_id=NEW.user_id AND id=NEW.insight_event_id AND transcript_id IS NULL; END;
--> statement-breakpoint

CREATE TRIGGER proactive_transcript_append_only BEFORE UPDATE ON proactive_transcript_entries
BEGIN SELECT CASE WHEN OLD.kind='message' THEN RAISE(ABORT,'proactive_message_transcript_immutable') ELSE RAISE(ABORT,'proactive_transcript_append_only') END; END;
--> statement-breakpoint

CREATE TRIGGER proactive_transcript_clear_links BEFORE DELETE ON proactive_transcript_entries WHEN OLD.kind='insight' BEGIN UPDATE insight_events SET transcript_id=NULL,transcript_kind=NULL WHERE user_id=OLD.user_id AND transcript_kind=OLD.kind AND transcript_id=OLD.id; END;
--> statement-breakpoint

CREATE TRIGGER proactive_transcript_retention_guard BEFORE DELETE ON proactive_transcript_entries
WHEN OLD.kind='insight' AND (OLD.expires_at_ms > unixepoch('now') * 1000) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='proactive_transcript_entries' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'proactive_transcript_retention_not_due'); END;
--> statement-breakpoint

CREATE TRIGGER proactivity_channel_frozen BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id
 OR NEW.role IS NOT OLD.role OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
 OR NEW.correlation_token IS NOT OLD.correlation_token OR NEW.portfolio_id IS NOT OLD.portfolio_id
 OR NEW.bsuid IS NOT OLD.bsuid OR NEW.business_phone_number_id IS NOT OLD.business_phone_number_id
 OR NEW.scheduled_at_ms IS NOT OLD.scheduled_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR NEW.time_zone IS NOT OLD.time_zone
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.template_json IS NOT NULL AND NEW.template_json IS NOT OLD.template_json)
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
)
BEGIN SELECT RAISE(ABORT,'proactivity_claim_frozen'); END;
--> statement-breakpoint

CREATE TRIGGER proactivity_governors_kind_immutable BEFORE UPDATE OF kind ON proactivity_governors WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'governor_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER proactivity_offer_immutable BEFORE UPDATE ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind
 OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.bsuid IS NOT OLD.bsuid
 OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND NEW.disclosure_message_id IS NOT OLD.disclosure_message_id)
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
)
BEGIN SELECT RAISE(ABORT,'consent_offer_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER proactivity_offer_replacement_immutable BEFORE UPDATE ON consent_offers
 WHEN NEW.kind<>'weekly-summary' AND (NEW.replaces_offer_id IS NOT OLD.replaces_offer_id
 )
BEGIN SELECT RAISE(ABORT,'consent_offer_replacement_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER processing_consent_renewal_requires_authority BEFORE INSERT ON consent_history
WHEN NEW.record_type='processing_renewal' AND ( NOT EXISTS (
  SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) r JOIN (SELECT * FROM consent_history WHERE record_type='processing_grant') g ON g.id=r.grant_record_id
  JOIN web_sessions w ON w.user_id=r.user_id
  WHERE r.id=NEW.withdrawal_id AND r.user_id=NEW.user_id AND g.user_id=NEW.user_id
    AND g.id=NEW.grant_record_id AND g.disclosure_json=NEW.disclosure_json
    AND r.occurred_at_ms<=NEW.occurred_at_ms AND w.id=NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.fresh_until_ms>NEW.occurred_at_ms AND w.idle_expires_at_ms>NEW.occurred_at_ms
    AND w.hard_expires_at_ms>NEW.occurred_at_ms
)
) BEGIN SELECT RAISE(ABORT,'consent_renewal_requires_authority'); END;
--> statement-breakpoint

CREATE TRIGGER processing_withdrawal_once BEFORE INSERT ON consent_history WHEN NEW.record_type='processing_withdrawal' AND EXISTS(SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) current WHERE current.user_id=NEW.user_id) BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint

CREATE TRIGGER provider_attempt_requires_handoff BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.handoff_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM whatsapp_provider_handoffs h JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 WHERE h.id=NEW.handoff_id AND h.pairing_id=NEW.pairing_id AND h.expires_at_ms>NEW.created_at_ms
 AND h.consumed_at_ms IS NULL AND h.decision IS NULL AND e.state='accepted' AND e.expires_at_ms>NEW.created_at_ms
)
BEGIN
 SELECT RAISE(ABORT,'provider_handoff_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER provider_credential_immutable BEFORE UPDATE ON provider_credentials
WHEN NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.user_id IS NOT OLD.user_id
 OR NEW.contact_email IS NOT OLD.contact_email OR NEW.established_at_ms IS NOT OLD.established_at_ms
BEGIN SELECT RAISE(ABORT,'provider_credential_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER provider_completion_immutable BEFORE UPDATE ON provider_authentication_attempts
WHEN (OLD.completed_at_ms IS NOT NULL AND (
 NEW.id IS NOT OLD.id
 OR NEW.pairing_id IS NOT OLD.pairing_id
 OR NEW.cookie_digest IS NOT OLD.cookie_digest
 OR NEW.nonce IS NOT OLD.nonce
 OR NEW.intent IS NOT OLD.intent
 OR NEW.disclosure_json IS NOT OLD.disclosure_json
 OR NEW.consent_at_ms IS NOT OLD.consent_at_ms
 OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR NEW.state IS NOT OLD.state
 OR NEW.issuer IS NOT OLD.issuer
 OR NEW.subject IS NOT OLD.subject
 OR NEW.contact_email IS NOT OLD.contact_email
 OR NEW.user_id IS NOT OLD.user_id
 OR NEW.provider IS NOT OLD.provider
 OR NEW.handoff_id IS NOT OLD.handoff_id
 OR NEW.completed_at_ms IS NOT OLD.completed_at_ms
 OR NEW.created_user IS NOT OLD.created_user))
 OR (NEW.completed_at_ms IS NOT OLD.completed_at_ms AND NOT(OLD.completed_at_ms IS NULL AND OLD.state='verified' AND NEW.state='completed' AND NEW.user_id IS NOT NULL AND NEW.cookie_digest=zeroblob(32) AND NEW.nonce='' AND NEW.contact_email IS NULL))
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER provider_completion_initial BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.completed_at_ms IS NOT NULL OR NEW.created_user IS NOT NULL
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER provider_completion_requires_proof BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.id AND a.state='verified'
 AND a.expires_at_ms>NEW.completed_at_ms AND p.expires_at_ms>NEW.completed_at_ms AND p.wrong_attempts<5
 AND (NEW.created_user=0 OR (
 a.intent='signup' AND EXISTS(SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') g WHERE g.user_id=NEW.user_id
 AND ((a.handoff_id IS NULL AND g.id=a.id AND g.disclosure_json=a.disclosure_json)
 OR (a.handoff_id IS NOT NULL AND g.id=(SELECT exchange_id FROM whatsapp_provider_handoffs WHERE id=a.handoff_id))))
 AND EXISTS(SELECT 1 FROM users t WHERE t.id=NEW.user_id AND t.trial_started_at_ms=NEW.completed_at_ms)
 AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN
 SELECT RAISE(ABORT,'provider_completion_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER recurring_confirmation_before_series_delete BEFORE DELETE ON recurring_series
WHEN OLD.confirmation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'recurring_confirmation_pending'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_confirmation_no_update BEFORE UPDATE ON recurring_series
WHEN OLD.confirmation_id IS NOT NULL AND (NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmation_context_json IS NOT OLD.confirmation_context_json OR NEW.confirmation_json IS NOT OLD.confirmation_json OR NEW.digest_excluded IS NOT OLD.digest_excluded OR NEW.confirmation_sequence IS NOT OLD.confirmation_sequence OR NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id)
 AND NOT (NEW.confirmation_id IS NULL AND NEW.confirmed_at IS NULL AND NEW.confirmation_context_json IS NULL AND NEW.confirmation_json IS NULL AND NEW.digest_excluded IS NULL AND NEW.confirmation_sequence IS NULL AND NEW.user_id IS OLD.user_id AND NEW.id IS OLD.id AND NEW.currency IS OLD.currency AND NEW.counterparty_key IS OLD.counterparty_key AND NEW.series_json IS OLD.series_json AND NEW.evidence_json IS OLD.evidence_json AND NEW.reference_json IS OLD.reference_json AND NEW.valid IS OLD.valid AND EXISTS(
  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id AND q.user_id=p.user_id
  WHERE p.user_id=OLD.user_id AND p.store_id='recurring_confirmations'))
BEGIN SELECT RAISE(ABORT,'recurring_confirmation_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_digest_consumption_immutable_shared BEFORE UPDATE OF disposition ON recurring_digest_items
 WHEN OLD.disposition IS NOT NULL AND NEW.disposition IS NOT NULL BEGIN SELECT RAISE(ABORT,'recurring_consumption_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_digest_instructions_companions_initial BEFORE INSERT ON schedules WHEN NEW.kind='digest' AND (NEW.source_checkpoint IS NOT NULL OR NEW.source_cursor IS NOT NULL OR NEW.source_cutoff_at_ms IS NOT NULL OR NEW.source_complete IS NOT NULL) BEGIN SELECT RAISE(ABORT,'recurring_digest_instructions_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_delete BEFORE DELETE ON insight_reports WHEN OLD.kind='offer-request' AND ((OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities')))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_insert BEFORE INSERT ON insight_reports WHEN NEW.kind='offer-request' AND ((NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities')))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_update BEFORE UPDATE ON insight_reports WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND ((NEW.current_recurring_opportunity IS NOT OLD.current_recurring_opportunity) AND ((OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))) OR (NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND (OLD.current_recurring_opportunity=1 AND NEW.current_recurring_opportunity IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER refund_acceptance_limit BEFORE INSERT ON refund_attempts
WHEN (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id AND status='pending')>=4
 OR (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id
   AND created_at_ms>NEW.created_at_ms-3600000)>=12
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER refund_claim_immutable BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NOT NULL AND (NEW.submission_claimed_at_ms IS NOT OLD.submission_claimed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_claim_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER refund_claim_requires_pending BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NULL AND NEW.submission_claimed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r
  JOIN billing_attempt_context a ON a.id=r.billing_attempt_id
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.transaction_id=r.transaction_id AND e.attempt_id=a.id
  WHERE r.id=NEW.id AND r.status='pending' AND a.status='succeeded'
    AND a.wompi_environment='sandbox' AND e.status='APPROVED'
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence
      WHERE attempt_id=a.id AND status='APPROVED')=1))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.access_ends_at_ms IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NOT NULL AND (NEW.provider_refund_id IS NOT OLD.provider_refund_id OR NEW.verified_status IS NOT OLD.verified_status OR NEW.observed_at_ms IS NOT OLD.observed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER refund_evidence_requires_claim BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r JOIN (SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL) c ON c.refund_id=r.id
  WHERE r.id=NEW.id AND r.status='pending' AND NEW.observed_at_ms>=r.created_at_ms
    AND ((r.kind='refund' AND NEW.verified_status IN ('APPROVED','DECLINED','CANCELLED'))
      OR (r.kind='card-void' AND NEW.verified_status='VOIDED'))))
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_invalid_claim');
END;
--> statement-breakpoint

CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_attempts' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NOT EXISTS (SELECT 1 FROM billing_attempt_context a
  JOIN (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) e ON e.attempt_id=a.id
  JOIN payment_source_context p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND a.wompi_environment=NEW.wompi_environment
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM (SELECT rowid,transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL) AS billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > (SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id) - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR NOT EXISTS (SELECT 1 FROM refund_charge_context a WHERE a.id=NEW.billing_attempt_id)
  OR (NEW.kind='card-void' AND NEW.amount_in_cents<>(SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id OR NEW.wompi_environment<>OLD.wompi_environment
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.treatment_json<>OLD.treatment_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents
 OR NEW.kind<>OLD.kind OR NEW.operator_id<>OLD.operator_id OR NEW.created_at_ms<>OLD.created_at_ms
 OR (OLD.status<>'pending' AND (NEW.status<>OLD.status OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms
   OR NEW.failure IS NOT OLD.failure OR NEW.progress<>OLD.progress))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER refund_verified_settlement AFTER UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
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
 UPDATE billing_attempts AS billing_followup_outbox SET followup_due_at_ms=NULL WHERE followup_due_at_ms IS NOT NULL AND id IN
    (SELECT a.id FROM billing_attempt_context a JOIN refund_attempts r ON r.user_id=a.user_id
      WHERE r.id=NEW.id AND r.status='succeeded');
END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_delete_fence BEFORE DELETE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_fence BEFORE UPDATE ON insight_reports WHEN NEW.reminder_governor_counted IS NOT OLD.reminder_governor_counted AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_insert_fence BEFORE INSERT ON insight_reports WHEN NEW.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_preserve_delete BEFORE DELETE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.delivery_id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_preserve_update BEFORE UPDATE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND NEW.reminder_governor_counted IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.delivery_id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER reminder_governor_attention_reset AFTER UPDATE OF standing_json ON proactivity_governors
WHEN NEW.kind='reminder' AND (json_extract(NEW.standing_json,'$._tag')='Attentive' AND json_extract(NEW.standing_json,'$.unanswered')=0
)
BEGIN
 UPDATE proactivity_governors AS reminder_governors SET question_id=NULL,question_delivered_at_ms=NULL,notice_turn_id=NULL,notice_completed=0 WHERE kind='reminder' AND user_id=NEW.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER resource_admission_require_every_claim
BEFORE INSERT ON resource_admission_grants
WHEN (
  SELECT count(*)
  FROM resource_admission_events
  WHERE grant_id = NEW.id
) <> NEW.claim_count
BEGIN
  SELECT RAISE(ABORT, 'resource_admission_refused');
END;
--> statement-breakpoint

CREATE TRIGGER reviewed_statement_entitlement_update AFTER UPDATE OF workspace_state ON ingestion_review_items
WHEN NEW.source_kind='statement' AND NEW.workspace_state='created' AND OLD.workspace_state IS NOT 'created' BEGIN
 UPDATE users SET backfill_consumed_at_ms=coalesce(backfill_consumed_at_ms,NEW.workspace_updated_at_ms)
 WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.statement_submission_id;
END;
--> statement-breakpoint

CREATE TRIGGER schedule_executions_no_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_executions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_executions_no_update BEFORE UPDATE ON schedule_history WHEN (OLD.record_type='execution' OR NEW.record_type='execution') BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_history_type_immutable BEFORE UPDATE ON schedule_history WHEN NEW.record_type IS NOT OLD.record_type BEGIN SELECT RAISE(ABORT,'schedule_history_type_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_revisions_no_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_revisions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_revisions_no_update BEFORE UPDATE ON schedule_history WHEN (OLD.record_type='revision' OR NEW.record_type='revision') BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedules_identity_immutable BEFORE UPDATE ON schedules WHEN NEW.kind<>OLD.kind OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id BEGIN SELECT RAISE(ABORT,'schedule_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER source_attestation_no_delete BEFORE DELETE ON source_attestations
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='source_attestations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER sql_assertions_refusal_insert BEFORE INSERT ON sql_assertions
WHEN NEW.accepted IS NOT 1
BEGIN
  SELECT CASE NEW.scope
    WHEN 'canonical_request' THEN RAISE(ABORT, 'canonical_request_rate')
    WHEN 'commercial_allowance' THEN RAISE(ABORT, 'commercial_authority_required')
    WHEN 'connection_browser' THEN RAISE(ABORT, 'connection_browser_commit')
    WHEN 'media_capacity' THEN RAISE(ABORT, 'media_work_capacity')
    WHEN 'media_publication' THEN RAISE(ABORT, 'media_publication_required')
    WHEN 'recurring_cursor' THEN RAISE(ABORT, 'recurring_cursor_changed')
  END;
END;
--> statement-breakpoint

CREATE TRIGGER sql_assertions_refusal_update BEFORE UPDATE ON sql_assertions
WHEN NEW.accepted IS NOT 1
BEGIN
  SELECT CASE NEW.scope
    WHEN 'canonical_request' THEN RAISE(ABORT, 'canonical_request_rate')
    WHEN 'commercial_allowance' THEN RAISE(ABORT, 'commercial_authority_required')
    WHEN 'connection_browser' THEN RAISE(ABORT, 'connection_browser_commit')
    WHEN 'media_capacity' THEN RAISE(ABORT, 'media_work_capacity')
    WHEN 'media_publication' THEN RAISE(ABORT, 'media_publication_required')
    WHEN 'recurring_cursor' THEN RAISE(ABORT, 'recurring_cursor_changed')
  END;
END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_entitlements_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_entitlements_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_entitlements_field_fence_update BEFORE UPDATE ON users WHEN (NEW.backfill_present IS NOT OLD.backfill_present OR NEW.backfill_submission_id IS NOT OLD.backfill_submission_id OR NEW.backfill_consumed_at_ms IS NOT OLD.backfill_consumed_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_entitlements_field_preserve_delete BEFORE DELETE ON users WHEN OLD.backfill_present IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_backfill_entitlements','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'submission_id',OLD.backfill_submission_id,'consumed_at_ms',OLD.backfill_consumed_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_entitlements_field_preserve_update BEFORE UPDATE ON users WHEN OLD.backfill_present IS NOT NULL AND NEW.backfill_present IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_backfill_entitlements','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'submission_id',OLD.backfill_submission_id,'consumed_at_ms',OLD.backfill_consumed_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER statement_backfill_on_capture AFTER INSERT ON statement_record_outcomes
WHEN NEW.outcome = 'accepted'
BEGIN
  UPDATE users
    SET backfill_consumed_at_ms = coalesce(backfill_consumed_at_ms, unixepoch('now') * 1000)
    WHERE backfill_present IS NOT NULL AND id = NEW.user_id AND backfill_submission_id = NEW.submission_id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='abandoned' BEGIN
 UPDATE ingestion_review_items SET workspace_state='abandoned',workspace_revision=coalesce(workspace_revision,0)+1,draft_json=NULL,workspace_updated_at_ms=NEW.clarification_ended_at_ms,workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id)
 WHERE source_kind='statement' AND statement_submission_id=NEW.id AND coalesce(workspace_state,'pending')='pending';
 UPDATE ingestion_review_items SET evidence_state='expired',original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL
 WHERE source_kind='statement' AND statement_submission_id=NEW.id AND evidence_state='retained' AND workspace_state='abandoned';
 UPDATE users SET backfill_submission_id=NULL WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.id AND backfill_consumed_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER statement_clarification_release AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='completed'
BEGIN
 UPDATE users SET backfill_submission_id=NULL
 WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.id AND backfill_consumed_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER statement_clarification_transition BEFORE UPDATE OF clarification_state ON statement_submissions
WHEN OLD.clarification_state IS NOT NULL AND NOT ((NEW.clarification_state=OLD.clarification_state AND NEW.clarification_ended_at_ms IS OLD.clarification_ended_at_ms)
 OR (OLD.clarification_state='awaiting' AND NEW.clarification_state IN ('completed','abandoned') AND NEW.clarification_ended_at_ms IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT,'statement_clarification_terminal');
END;
--> statement-breakpoint

CREATE TRIGGER statement_companions_valid_insert BEFORE INSERT ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))),0)=0 BEGIN
 SELECT RAISE(ABORT,'statement_companions_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER statement_companions_valid_update BEFORE UPDATE ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))),0)=0 BEGIN
 SELECT RAISE(ABORT,'statement_companions_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER statement_document_immutable BEFORE UPDATE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND NOT((NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.document_media_id IS OLD.document_media_id AND NEW.document_created_at_ms IS OLD.document_created_at_ms) AND (OLD.document_staging_id IS NULL OR (NEW.document_staging_id IS OLD.document_staging_id AND NEW.document_reference_json IS OLD.document_reference_json))) AND NOT(NEW.document_media_id IS NULL AND NEW.document_staging_id IS NULL AND NEW.document_upload_grant_id IS NULL AND NEW.document_upload_expires_at_ms IS NULL AND NEW.document_reference_json IS NULL AND NEW.document_created_at_ms IS NULL) BEGIN SELECT RAISE(ABORT,'statement_document_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_document_published AFTER UPDATE OF hosted_session_id ON statement_submissions
WHEN OLD.hosted_session_id IS NULL AND NEW.hosted_session_id IS NOT NULL
BEGIN
 UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL,document_created_at_ms=NULL WHERE id=NEW.hosted_turn_id AND user_id=NEW.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_document_same_user BEFORE UPDATE ON hosted_turns WHEN NEW.document_staging_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_staging_objects WHERE id=NEW.document_staging_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'statement_document_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_document_staging_deleted AFTER DELETE ON statement_staging_objects BEGIN UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL,document_created_at_ms=NULL WHERE document_staging_id=OLD.id; END;
--> statement-breakpoint

CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing') AND NEW.needs_review_rows>0
BEGIN
 UPDATE statement_submissions SET clarification_state='awaiting',clarification_expires_at_ms=(SELECT min(evidence_expires_at_ms) FROM statement_review_context WHERE submission_id=NEW.id),clarification_ended_at_ms=NULL WHERE id=NEW.id;
 UPDATE statement_submissions SET clarification_state='abandoned',clarification_ended_at_ms=NEW.completed_at_ms WHERE id=NEW.id AND clarification_expires_at_ms<=NEW.completed_at_ms;
END;
--> statement-breakpoint

CREATE TRIGGER statement_interpretation_context_immutable BEFORE UPDATE OF id,user_id,staging_id,parser_revision,source_format,service_market,locale,time_zone ON statement_submissions WHEN EXISTS(SELECT 1 FROM statement_materializations WHERE submission_id=OLD.id) AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.staging_id IS NOT OLD.staging_id OR NEW.parser_revision IS NOT OLD.parser_revision OR NEW.source_format IS NOT OLD.source_format OR NEW.service_market IS NOT OLD.service_market OR NEW.locale IS NOT OLD.locale OR NEW.time_zone IS NOT OLD.time_zone) BEGIN SELECT RAISE(ABORT,'statement_interpretation_context_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_identity BEFORE UPDATE ON statement_materializations
WHEN (NEW.submission_id IS NOT OLD.submission_id OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.parts_sha256 IS NOT OLD.parts_sha256 OR NEW.representation_revision IS NOT OLD.representation_revision OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.headers_json IS NOT OLD.headers_json OR NEW.row_count IS NOT OLD.row_count OR NEW.part_count IS NOT OLD.part_count OR NEW.byte_length IS NOT OLD.byte_length OR OLD.state='ready' OR NEW.state<>'ready')
BEGIN SELECT RAISE(ABORT,'statement_materialization_identity'); END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_owner BEFORE INSERT ON statement_materializations
WHEN NEW.state<>'building' OR NOT EXISTS(SELECT 1 FROM statement_submissions s JOIN statement_staging_objects o ON o.id=s.staging_id AND o.user_id=s.user_id
 WHERE s.id=NEW.submission_id AND s.status IN ('queued','processing') AND s.parser_revision IS NOT NULL AND s.source_format IS NOT NULL
 AND s.service_market IS NOT NULL AND s.locale IS NOT NULL AND s.time_zone IS NOT NULL
 AND o.sha256=NEW.source_sha256 AND s.retention_expires_at_ms=NEW.expires_at_ms)
BEGIN SELECT RAISE(ABORT,'statement_materialization_owner'); END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_part_guard BEFORE INSERT ON statement_materialization_parts
WHEN NOT EXISTS (SELECT 1 FROM statement_materializations m JOIN statement_submissions s ON s.id=m.submission_id WHERE m.submission_id=NEW.submission_id
  AND m.state='building' AND s.status IN ('queued','processing'))
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_part_guard');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_part_immutable BEFORE UPDATE ON statement_materialization_parts
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_terminal AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') BEGIN
 DELETE FROM statement_materializations WHERE submission_id=NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_origin_no_resumption BEFORE UPDATE OF hosted_session_id,hosted_turn_id,hosted_expires_at_ms,hosted_abandoned_at_ms ON statement_submissions
WHEN OLD.hosted_session_id IS NOT NULL AND (OLD.hosted_abandoned_at_ms IS NOT NULL OR NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id OR NEW.hosted_session_id != OLD.hosted_session_id OR NEW.hosted_turn_id != OLD.hosted_turn_id
)
BEGIN
 SELECT RAISE(ABORT, 'statement_origin_terminal');
END;
--> statement-breakpoint

CREATE TRIGGER statement_partial_accounting_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status='failed' AND OLD.status IN ('queued','processing')
  AND NEW.input_rows IS NULL AND NEW.processed_rows>0
BEGIN
 UPDATE statement_submissions SET input_rows=processed_rows,
    accepted_rows=processed_accepted_rows, needs_review_rows=processed_review_rows
    WHERE id=NEW.id AND user_id=NEW.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_partial_backfill_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
BEGIN
 UPDATE users
    SET backfill_submission_id = CASE WHEN backfill_consumed_at_ms IS NULL THEN NULL ELSE backfill_submission_id END
    WHERE backfill_present IS NOT NULL AND id = NEW.user_id AND backfill_submission_id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_progress AFTER INSERT ON statement_record_outcomes
BEGIN
 UPDATE statement_submissions SET processed_rows=processed_rows+1,
  processed_accepted_rows=processed_accepted_rows+(NEW.outcome='accepted'),
  processed_review_rows=processed_review_rows+(NEW.outcome='needs-review')
  WHERE id=NEW.submission_id AND user_id=NEW.user_id;
END;
--> statement-breakpoint

CREATE TRIGGER statement_progress_conservation BEFORE UPDATE ON statement_submissions
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
  OR NEW.processed_rows NOT BETWEEN 0 AND 20000
  OR NEW.processed_rows<>NEW.processed_accepted_rows+NEW.processed_review_rows
  OR NEW.processed_rows<>coalesce((SELECT record_number FROM statement_record_outcomes
    WHERE submission_id=NEW.id ORDER BY record_number DESC LIMIT 1),0)
  OR NOT (
    (NEW.processed_rows=OLD.processed_rows
      AND NEW.processed_accepted_rows=OLD.processed_accepted_rows
      AND NEW.processed_review_rows=OLD.processed_review_rows)
    OR (NEW.processed_rows=OLD.processed_rows+1
      AND NEW.processed_accepted_rows=OLD.processed_accepted_rows+
        (SELECT outcome='accepted' FROM statement_record_outcomes
          WHERE submission_id=NEW.id AND user_id=NEW.user_id AND record_number=NEW.processed_rows)
      AND NEW.processed_review_rows=OLD.processed_review_rows+
        (SELECT outcome='needs-review' FROM statement_record_outcomes
          WHERE submission_id=NEW.id AND user_id=NEW.user_id AND record_number=NEW.processed_rows))
  )
BEGIN
 SELECT RAISE(ABORT,'statement_progress_conservation');
END;
--> statement-breakpoint

CREATE TRIGGER statement_progress_initial BEFORE INSERT ON statement_submissions
WHEN NEW.processed_rows<>0 OR NEW.processed_accepted_rows<>0 OR NEW.processed_review_rows<>0
BEGIN
 SELECT RAISE(ABORT,'statement_progress_initial');
END;
--> statement-breakpoint

CREATE TRIGGER statement_progress_order BEFORE INSERT ON statement_record_outcomes
WHEN NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=NEW.submission_id AND s.user_id=NEW.user_id
  AND s.processed_rows+1=NEW.record_number)
BEGIN
 SELECT RAISE(ABORT,'statement_progress_order');
END;
--> statement-breakpoint

CREATE TRIGGER statement_progress_terminal BEFORE UPDATE OF status,processed_rows,processed_accepted_rows,processed_review_rows,input_rows,accepted_rows,needs_review_rows ON statement_submissions
WHEN (OLD.status IN ('completed','failed') AND NEW.status<>OLD.status)
  OR (NEW.status='completed' AND (NEW.processed_rows=0
    OR NEW.input_rows IS NOT NEW.processed_rows
    OR NEW.accepted_rows IS NOT NEW.processed_accepted_rows
    OR NEW.needs_review_rows IS NOT NEW.processed_review_rows))
  OR (NEW.status='failed' AND NEW.input_rows IS NOT NULL AND (
    NEW.input_rows IS NOT NEW.processed_rows
    OR NEW.accepted_rows IS NOT NEW.processed_accepted_rows
    OR NEW.needs_review_rows IS NOT NEW.processed_review_rows))
  OR (NEW.status='failed' AND OLD.status='failed' AND NEW.processed_rows>0
    AND NEW.input_rows IS NULL)
BEGIN
 SELECT RAISE(ABORT,'statement_progress_terminal');
END;
--> statement-breakpoint

CREATE TRIGGER statement_record_outcome_no_delete BEFORE DELETE ON statement_record_outcomes
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='statement_record_outcomes' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'statement_outcome_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER statement_record_outcome_no_update BEFORE UPDATE ON statement_record_outcomes
BEGIN SELECT RAISE(ABORT, 'statement_outcome_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER statement_review_capacity_delete AFTER DELETE ON ingestion_review_items
WHEN OLD.source_kind='statement' AND OLD.evidence_state = 'retained'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count - 1 WHERE id = 1; END;
--> statement-breakpoint

CREATE TRIGGER statement_review_capacity_insert AFTER INSERT ON ingestion_review_items
WHEN NEW.source_kind='statement' AND NEW.evidence_state = 'retained'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count + 1 WHERE id = 1; END;
--> statement-breakpoint

CREATE TRIGGER statement_review_capacity_settlement AFTER UPDATE OF evidence_state ON ingestion_review_items
WHEN OLD.source_kind='statement' AND OLD.evidence_state = 'retained' AND NEW.evidence_state != 'retained'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count - 1 WHERE id = 1; END;
--> statement-breakpoint

CREATE TRIGGER statement_review_pending_cap BEFORE INSERT ON ingestion_review_items
WHEN NEW.source_kind='statement' AND NEW.evidence_state = 'retained' AND
  COALESCE((SELECT pending_count FROM statement_review_capacity WHERE id = 1), 5000) >= 5000
BEGIN SELECT RAISE(ABORT, 'statement_review_capacity'); END;
--> statement-breakpoint

CREATE TRIGGER statement_review_settlement_only BEFORE UPDATE ON ingestion_review_items
WHEN (OLD.source_kind='statement' OR NEW.source_kind='statement') AND NOT (NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.source_kind IS OLD.source_kind AND NEW.email_receipt_id IS OLD.email_receipt_id AND NEW.media_submission_id IS OLD.media_submission_id AND NEW.statement_submission_id IS OLD.statement_submission_id AND NEW.record_number IS OLD.record_number AND NEW.reason IS OLD.reason AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.evidence_expires_at_ms IS OLD.evidence_expires_at_ms AND NEW.service_market IS OLD.service_market AND NEW.locale IS OLD.locale AND NEW.time_zone IS OLD.time_zone AND NEW.source_format IS OLD.source_format AND NEW.parser_revision IS OLD.parser_revision AND NEW.extractor_revision IS OLD.extractor_revision AND NEW.issues_json IS OLD.issues_json AND ((OLD.evidence_state='retained' AND NEW.evidence_state IN ('resolved','expired') AND NEW.original_evidence IS NULL AND NEW.known_money_json IS NULL AND NEW.suggestions_json IS NULL AND (NEW.evidence_state='expired' OR NEW.workspace_state='created')) OR (NEW.evidence_state=OLD.evidence_state AND NEW.original_evidence IS OLD.original_evidence AND NEW.known_money_json IS OLD.known_money_json AND (NEW.suggestions_json IS OLD.suggestions_json OR NEW.suggestions_json IS NULL))))
BEGIN SELECT RAISE(ABORT,'review_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_submission_state_insert BEFORE INSERT ON statement_submissions
WHEN coalesce((
  NEW.source_format IS NOT NULL AND NEW.parser_revision IS NOT NULL
  AND NEW.service_market IS NOT NULL AND NEW.locale IS NOT NULL AND NEW.time_zone IS NOT NULL
  AND NEW.retention_expires_at_ms > NEW.submitted_at_ms
  AND (
    (NEW.status = 'queued' AND NEW.started_at_ms IS NULL AND NEW.completed_at_ms IS NULL
      AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'processing' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NULL AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'completed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NULL
      AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)
    OR (NEW.status = 'failed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NOT NULL
      AND ((NEW.input_rows IS NULL AND NEW.accepted_rows IS NULL AND NEW.needs_review_rows IS NULL)
        OR (NEW.input_rows > 0 AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)))
  )
), 0) = 0
BEGIN
 SELECT RAISE(ABORT, 'statement_submission_state');
END;
--> statement-breakpoint

CREATE TRIGGER statement_submission_state_update BEFORE UPDATE ON statement_submissions
WHEN coalesce((
  NEW.source_format IS NOT NULL AND NEW.parser_revision IS NOT NULL
  AND NEW.service_market IS NOT NULL AND NEW.locale IS NOT NULL AND NEW.time_zone IS NOT NULL
  AND NEW.retention_expires_at_ms > NEW.submitted_at_ms
  AND (
    (NEW.status = 'queued' AND NEW.started_at_ms IS NULL AND NEW.completed_at_ms IS NULL
      AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'processing' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NULL AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'completed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NULL
      AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)
    OR (NEW.status = 'failed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NOT NULL
      AND ((NEW.input_rows IS NULL AND NEW.accepted_rows IS NULL AND NEW.needs_review_rows IS NULL)
        OR (NEW.input_rows > 0 AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)))
  )
), 0) = 0
BEGIN
 SELECT RAISE(ABORT, 'statement_submission_state');
END;
--> statement-breakpoint

CREATE TRIGGER statement_submissions_companions_initial BEFORE INSERT ON statement_submissions WHEN NEW.work_published_at_ms IS NOT NULL OR NEW.work_published_at_ms IS NOT NULL OR NEW.work_last_attempt_at_ms IS NOT NULL OR NEW.work_last_reconciled_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'statement_submissions_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER statement_terminal_material AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing')
BEGIN
 UPDATE statement_staging_objects SET status='deleting',published_submission_id=NULL
  WHERE id=NEW.staging_id AND user_id=NEW.user_id AND status='published'
    AND object_deleted_at_ms IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER statement_whatsapp_documents_field_fence_delete BEFORE DELETE ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_whatsapp_documents_field_fence_insert BEFORE INSERT ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_whatsapp_documents_field_fence_update BEFORE UPDATE ON hosted_turns WHEN (NEW.document_media_id IS NOT OLD.document_media_id OR NEW.document_staging_id IS NOT OLD.document_staging_id OR NEW.document_upload_grant_id IS NOT OLD.document_upload_grant_id OR NEW.document_upload_expires_at_ms IS NOT OLD.document_upload_expires_at_ms OR NEW.document_reference_json IS NOT OLD.document_reference_json OR NEW.document_created_at_ms IS NOT OLD.document_created_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER statement_whatsapp_documents_field_preserve_delete BEFORE DELETE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_whatsapp_documents','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'media_id',OLD.document_media_id,'staging_id',OLD.document_staging_id,'upload_grant_id',OLD.document_upload_grant_id,'upload_expires_at_ms',OLD.document_upload_expires_at_ms,'reference_json',OLD.document_reference_json,'created_at_ms',OLD.document_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER statement_whatsapp_documents_field_preserve_update BEFORE UPDATE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND NEW.document_media_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_whatsapp_documents','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'media_id',OLD.document_media_id,'staging_id',OLD.document_staging_id,'upload_grant_id',OLD.document_upload_grant_id,'upload_expires_at_ms',OLD.document_upload_expires_at_ms,'reference_json',OLD.document_reference_json,'created_at_ms',OLD.document_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_fence AFTER INSERT ON subscription_cancellations
BEGIN
 UPDATE billing_attempts AS billing_followup_outbox SET followup_due_at_ms=NULL WHERE followup_due_at_ms IS NOT NULL AND id IN (SELECT id FROM billing_attempt_context WHERE subscription_id=NEW.subscription_id);
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed'
    AND id IN (SELECT id FROM billing_attempt_context WHERE subscription_id=NEW.subscription_id);
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard_insert BEFORE INSERT ON subscription_cancellations
WHEN NEW.cancelled_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (SELECT * FROM subscription_standing) sub JOIN billing_attempt_context a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN payment_source_context source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE a.subscription_id=NEW.subscription_id AND a.id=NEW.paid_attempt_id AND a.payment_source_id=NEW.payment_source_id
 AND NEW.paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,billing_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE access_ends_at_ms IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.source_cancellation_state=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_immutable BEFORE UPDATE ON subscription_cancellations
WHEN OLD.cancelled_at_ms IS NOT NULL AND NEW.cancelled_at_ms IS NOT NULL AND (NEW.subscription_id<>OLD.subscription_id OR NEW.paid_attempt_id<>OLD.paid_attempt_id OR NEW.payment_source_id<>OLD.payment_source_id
 OR NEW.cancelled_at_ms<>OLD.cancelled_at_ms OR NEW.paid_through_ms<>OLD.paid_through_ms
 OR (OLD.source_cancellation_state IN ('detached','voided') AND NEW.source_cancellation_state<>OLD.source_cancellation_state)
 OR (OLD.void_started_at_ms IS NOT NULL AND NEW.void_started_at_ms IS NOT OLD.void_started_at_ms)
 OR (OLD.void_verified_at_ms IS NOT NULL AND NEW.void_verified_at_ms IS NOT OLD.void_verified_at_ms) OR NEW.verification_count<OLD.verification_count )
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_no_delete BEFORE DELETE ON subscription_cancellations
WHEN OLD.cancelled_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_cancellations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_prices_immutable BEFORE UPDATE ON subscription_prices
WHEN NEW.id <> OLD.id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
  OR NEW.billing_period <> OLD.billing_period OR NEW.service_market <> OLD.service_market
  OR NEW.tax_treatment <> OLD.tax_treatment OR NEW.terms_json <> OLD.terms_json
BEGIN SELECT RAISE(ABORT, 'price_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER subscription_prices_no_delete BEFORE DELETE ON subscription_prices
BEGIN SELECT RAISE(ABORT, 'price_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER subscription_renewal_stop_immutable BEFORE UPDATE OF renewal_stopped_at_ms ON refund_attempts
WHEN OLD.renewal_stopped_at_ms IS NOT NULL AND (NEW.renewal_stopped_at_ms IS NOT OLD.renewal_stopped_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER transaction_correction_no_delete BEFORE DELETE ON transaction_corrections
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='transaction_corrections' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'correction_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER transaction_correction_no_update BEFORE UPDATE ON transaction_corrections
BEGIN SELECT RAISE(ABORT, 'correction_append_only'); END;
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

CREATE TRIGGER transaction_fact_link_delete AFTER DELETE ON transaction_reconciliation_decisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transaction_reconciliation_decisions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = OLD.user_id AND fact_revision IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_link_insert AFTER INSERT ON transaction_reconciliation_decisions BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER transaction_fact_link_update AFTER UPDATE ON transaction_reconciliation_decisions BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
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

CREATE TRIGGER transcript_no_update BEFORE UPDATE ON transcript_entries
BEGIN SELECT RAISE(ABORT, 'transcript_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER transcript_retention_guard BEFORE DELETE ON transcript_entries
WHEN (NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id AND user_id = OLD.user_id
  AND status <> 'pending' AND terminal_at_ms < (unixepoch('now') * 1000 - 2592000000))
AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,user_id,id AS hosted_session_id,compacted_text AS text,compacted_through_sequence AS through_sequence,compacted_revision AS revision,compacted_nonce AS nonce,compacted_at_ms AS updated_at_ms FROM hosted_agent_sessions WHERE compacted_revision IS NOT NULL) AS c
  JOIN hosted_turns AS t ON t.id = OLD.turn_id AND t.user_id = OLD.user_id
  WHERE c.user_id = OLD.user_id AND c.hosted_session_id = OLD.hosted_session_id
    AND c.through_sequence >= OLD.sequence AND t.status <> 'pending')) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='transcript_entries' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'transcript_retention_not_due');
END;
--> statement-breakpoint

CREATE TRIGGER users_trial_immutable_delete BEFORE DELETE ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='users' AND p.user_id=OLD.id AND q.user_id=OLD.id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER users_trial_immutable_update BEFORE UPDATE OF trial_started_at_ms,trial_ends_at_ms ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND (NEW.trial_started_at_ms IS NOT OLD.trial_started_at_ms OR NEW.trial_ends_at_ms IS NOT OLD.trial_ends_at_ms)
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER verified_email_credentials_field_fence_delete BEFORE DELETE ON verified_email_credentials WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER verified_email_credentials_field_fence_insert BEFORE INSERT ON verified_email_credentials WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER verified_email_credentials_field_fence_update BEFORE UPDATE ON verified_email_credentials WHEN (NEW.user_id IS NOT OLD.user_id OR NEW.address IS NOT OLD.address OR NEW.verified_at_ms IS NOT OLD.verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='verified_email_credentials'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER web_session_requires_pairing BEFORE INSERT ON web_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p WHERE p.id = NEW.pairing_id
    AND p.state = 'consumed' AND p.user_id = NEW.user_id
    AND p.expires_at_ms > NEW.created_at_ms
)
BEGIN
 SELECT RAISE(ABORT, 'web_session_invalid_pairing');
END;
--> statement-breakpoint

CREATE TRIGGER weekly_consent_offer_immutable BEFORE UPDATE ON consent_offers
WHEN NEW.kind='weekly-summary' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.disclosure_json <> OLD.disclosure_json
 OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND (NEW.disclosure_message_id IS NOT OLD.disclosure_message_id OR NEW.disclosed_at_ms IS NOT OLD.disclosed_at_ms))
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
)
BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_consent_source_immutable BEFORE UPDATE ON consent_offers WHEN NEW.kind='weekly-summary' AND (NEW.source_id IS NOT OLD.source_id OR NEW.rejection_id IS NOT OLD.rejection_id )
BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_delete_fence BEFORE DELETE ON insight_events WHEN OLD.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_fence BEFORE UPDATE ON insight_events WHEN NEW.weekly_governor_counted IS NOT OLD.weekly_governor_counted AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_insert_fence BEFORE INSERT ON insight_events WHEN NEW.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'insight_event_id',OLD.id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.weekly_governor_counted=1 AND NEW.weekly_governor_counted IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'insight_event_id',OLD.id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER weekly_price_notice AFTER UPDATE OF published_order ON subscription_prices
WHEN NEW.published_order = 1 AND OLD.published_order IS NULL
BEGIN
 INSERT OR IGNORE INTO billing_price_notices (subscription_id, price_id, created_at_ms)
    SELECT a.subscription_id, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM (SELECT * FROM subscription_standing) s
    JOIN billing_attempt_context a ON a.id=s.attempt_id AND a.user_id=s.user_id
    JOIN payment_source_context source ON source.id=a.payment_source_id AND source.user_id=s.user_id
    WHERE a.billing_period='weekly' AND source.method='card' AND a.price_id<>NEW.id
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) stop WHERE stop.user_id=s.user_id);
END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_delivery_kind_immutable BEFORE UPDATE OF kind ON whatsapp_deliveries WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'whatsapp_delivery_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_event_kind_immutable BEFORE UPDATE ON whatsapp_event_records WHEN NEW.kind IS NOT OLD.kind BEGIN SELECT RAISE(ABORT,'whatsapp_event_kind_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_identities_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_identities_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_identities_field_fence_update BEFORE UPDATE ON users WHEN (NEW.id IS NOT OLD.id OR NEW.whatsapp_portfolio_id IS NOT OLD.whatsapp_portfolio_id OR NEW.whatsapp_bsuid IS NOT OLD.whatsapp_bsuid OR NEW.whatsapp_verified_at_ms IS NOT OLD.whatsapp_verified_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.whatsapp_portfolio_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_identities'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_provider_handoff_immutable BEFORE UPDATE ON whatsapp_provider_handoffs
WHEN NEW.id IS NOT OLD.id OR NEW.exchange_id IS NOT OLD.exchange_id
 OR (OLD.handoff_send_started_ms IS NOT NULL AND NEW.handoff_send_started_ms IS NOT OLD.handoff_send_started_ms)
 OR (OLD.pairing_id IS NOT NULL AND NEW.pairing_id IS NOT OLD.pairing_id)
 OR (OLD.review_code IS NOT NULL AND NEW.review_code IS NOT OLD.review_code)
 OR (OLD.review_started_ms IS NOT NULL AND NEW.review_started_ms IS NOT OLD.review_started_ms)
 OR (OLD.review_message_id IS NOT NULL AND NEW.review_message_id IS NOT OLD.review_message_id)
 OR (OLD.decision IS NOT NULL AND (NEW.decision IS NOT OLD.decision
   OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms
   OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms))
 OR (OLD.consumed_at_ms IS NOT NULL AND NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
BEGIN SELECT RAISE(ABORT,'whatsapp_handoff_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM provider_authentication_attempts WHERE id=NEW.id AND handoff_id IS NOT NULL)
AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a
 JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id AND h.pairing_id=a.pairing_id
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w ON w.user_id=NEW.user_id AND w.portfolio_id=e.portfolio_id AND w.bsuid=e.bsuid
 WHERE a.id=NEW.id AND h.decision='confirmed' AND h.review_message_id IS NOT NULL
 AND h.decision_message_id IS NOT NULL AND h.confirmed_at_ms IS NOT NULL AND h.consumed_at_ms IS NULL
 AND h.expires_at_ms>NEW.completed_at_ms AND e.expires_at_ms>NEW.completed_at_ms AND e.state='accepted'
)
BEGIN
 SELECT RAISE(ABORT,'whatsapp_provider_confirmation_invalid');
END;
--> statement-breakpoint

CREATE INDEX resource_counter_source_expiry ON resource_admission_counters(window_start_ms,scope_key)
WHERE policy_key='pat.pairing.source.v1';
--> statement-breakpoint

CREATE INDEX resource_admission_review_retention ON resource_admission_events(admitted_at_epoch_ms,grant_id)
WHERE policy_key='pat.review.session.v1';
--> statement-breakpoint

CREATE TRIGGER resource_admission_review_owner_insert BEFORE INSERT ON resource_admission_events
WHEN NEW.policy_key='pat.review.session.v1' AND NOT EXISTS(
 SELECT 1 FROM web_sessions WHERE id=NEW.owner_session_id AND user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT,'resource_admission_owner_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER resource_admission_review_owner_update BEFORE UPDATE ON resource_admission_events
WHEN NEW.policy_key='pat.review.session.v1' AND NOT EXISTS(
 SELECT 1 FROM web_sessions WHERE id=NEW.owner_session_id AND user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT,'resource_admission_owner_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER resource_admission_review_session_owner BEFORE UPDATE OF id,user_id ON web_sessions
WHEN EXISTS(SELECT 1 FROM resource_admission_events WHERE policy_key='pat.review.session.v1'
 AND owner_session_id=OLD.id AND (owner_session_id IS NOT NEW.id OR owner_user_id IS NOT NEW.user_id))
BEGIN SELECT RAISE(ABORT,'resource_admission_owner_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER resource_admission_review_grant_cleanup AFTER DELETE ON resource_admission_events
WHEN OLD.policy_key='pat.review.session.v1'
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events WHERE grant_id=OLD.grant_id)
BEGIN DELETE FROM resource_admission_grants WHERE id=OLD.grant_id; END;
--> statement-breakpoint

CREATE INDEX resource_counter_compaction_due ON resource_admission_counters(window_start_ms,scope_key)
 WHERE policy_key='hosted.compaction.user.v1';
--> statement-breakpoint

CREATE UNIQUE INDEX resource_counter_calendar_identity
 ON resource_admission_counters(policy_key,scope_key,window_start_ms) WHERE window_kind='calendar';
--> statement-breakpoint

CREATE TRIGGER support_recovery_case_immutable BEFORE UPDATE ON support_recovery_cases
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.pairing_id IS NOT OLD.pairing_id
 OR NEW.operator_issuer IS NOT OLD.operator_issuer OR NEW.operator_subject IS NOT OLD.operator_subject
 OR NEW.credential_revision IS NOT OLD.credential_revision OR NEW.opened_at_ms IS NOT OLD.opened_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.state IS NOT OLD.state OR NEW.closed_at_ms IS NOT OLD.closed_at_ms
BEGIN SELECT RAISE(ABORT,'recovery_case_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER support_recovery_event_metadata_immutable BEFORE UPDATE OF opened_event_id,opened_event_row_ref,decision_event_id,decision_event_row_ref ON support_recovery_cases
WHEN (NEW.opened_event_id IS NOT OLD.opened_event_id OR NEW.opened_event_row_ref IS NOT OLD.opened_event_row_ref
 OR NEW.decision_event_id IS NOT OLD.decision_event_id OR NEW.decision_event_row_ref IS NOT OLD.decision_event_row_ref)
 AND NOT (((NEW.opened_event_id IS OLD.opened_event_id AND NEW.opened_event_row_ref IS OLD.opened_event_row_ref)
 OR (NEW.opened_event_id IS NULL AND NEW.opened_event_row_ref IS NULL))
 AND ((NEW.decision_event_id IS OLD.decision_event_id AND NEW.decision_event_row_ref IS OLD.decision_event_row_ref)
 OR (NEW.decision_event_id IS NULL AND NEW.decision_event_row_ref IS NULL))
 AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing' AND p.store_id='support_recovery_events'))
BEGIN SELECT RAISE(ABORT,'recovery_case_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER support_recovery_case_owner BEFORE INSERT ON support_recovery_cases
WHEN NOT EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'recovery_case_owner'); END;
--> statement-breakpoint

CREATE UNIQUE INDEX support_recovery_opened_event_id ON support_recovery_cases(opened_event_id) WHERE opened_event_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX support_recovery_opened_event_ref ON support_recovery_cases(opened_event_row_ref) WHERE opened_event_row_ref IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX support_recovery_decision_event_id ON support_recovery_cases(decision_event_id) WHERE decision_event_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX support_recovery_decision_event_ref ON support_recovery_cases(decision_event_row_ref) WHERE decision_event_row_ref IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER support_recovery_event_metadata_delete BEFORE DELETE ON support_recovery_cases
WHEN (OLD.opened_event_id IS NOT NULL OR OLD.decision_event_id IS NOT NULL)
 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state NOT IN('AwaitingReview','Draining','Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id='support_recovery_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_lineage_initial BEFORE INSERT ON oauth_credentials
WHEN NEW.consumed_at_ms IS NOT NULL OR NEW.replacement_refresh_id IS NOT NULL OR NEW.refresh_event_id IS NOT NULL OR NEW.refresh_event_row_ref IS NOT NULL
BEGIN SELECT RAISE(ABORT,'oauth_lineage_initial'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_lineage_immutable BEFORE UPDATE ON oauth_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.connection_id IS NOT OLD.connection_id
 OR (OLD.consumed_at_ms IS NOT NULL AND NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
 OR ((NEW.replacement_refresh_id IS NOT OLD.replacement_refresh_id OR NEW.refresh_event_id IS NOT OLD.refresh_event_id OR NEW.refresh_event_row_ref IS NOT OLD.refresh_event_row_ref)
 AND NOT (
  OLD.consumed_at_ms IS NULL AND NEW.consumed_at_ms IS NOT NULL AND OLD.replacement_refresh_id IS NULL
  AND NEW.replacement_refresh_id IS NOT NULL AND NEW.refresh_event_id IS NULL AND NEW.refresh_event_row_ref IS NULL
  AND EXISTS(SELECT 1 FROM oauth_credentials r WHERE r.kind='refresh' AND r.id=NEW.replacement_refresh_id
    AND r.user_id=OLD.user_id AND r.connection_id=OLD.connection_id AND r.issued_at_ms=NEW.consumed_at_ms
    AND r.consumed_at_ms IS NULL AND NEW.consumed_at_ms>=OLD.issued_at_ms AND NEW.consumed_at_ms<OLD.expires_at_ms
    AND NOT EXISTS(SELECT 1 FROM json_each(r.scopes_json) n WHERE NOT EXISTS(SELECT 1 FROM json_each(OLD.scopes_json) o WHERE o.value=n.value)))
 ) AND NOT (
  NEW.replacement_refresh_id IS NULL AND NEW.refresh_event_id IS NULL AND NEW.refresh_event_row_ref IS NULL
  AND NEW.consumed_at_ms IS OLD.consumed_at_ms
  AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id AND q.user_id=p.user_id
    WHERE p.store_id='oauth_refresh_events' AND p.user_id=OLD.user_id AND q.state='Erasing')
 ))
 OR (OLD.consumed_at_ms IS NULL AND NEW.consumed_at_ms IS NOT NULL AND NEW.replacement_refresh_id IS NULL)
BEGIN SELECT RAISE(ABORT,'oauth_lineage_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_lineage_no_delete BEFORE DELETE ON oauth_credentials
WHEN OLD.replacement_refresh_id IS NOT NULL OR OLD.refresh_event_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'oauth_lineage_retained'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_intent_initial BEFORE INSERT ON oauth_operation_intents
WHEN NOT EXISTS(SELECT 1 FROM oauth_connections g WHERE g.id=NEW.connection_id AND g.user_id=NEW.user_id)
 OR NEW.browser_approved_at_ms IS NOT NULL OR NEW.browser_session_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'oauth_intent_owner'); END;
--> statement-breakpoint

CREATE TRIGGER oauth_intent_immutable BEFORE UPDATE ON oauth_operation_intents
WHEN NEW.reference IS NOT OLD.reference OR NEW.user_id IS NOT OLD.user_id OR NEW.connection_id IS NOT OLD.connection_id
 OR NEW.operation IS NOT OLD.operation OR NEW.input_json IS NOT OLD.input_json OR NEW.input_digest IS NOT OLD.input_digest
 OR NEW.binding_json IS NOT OLD.binding_json OR NEW.disclosure_revision IS NOT OLD.disclosure_revision
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR ((NEW.browser_approved_at_ms IS NOT OLD.browser_approved_at_ms OR NEW.browser_session_id IS NOT OLD.browser_session_id)
 AND NOT (OLD.browser_approved_at_ms IS NULL AND OLD.browser_session_id IS NULL
 AND typeof(NEW.browser_approved_at_ms)='integer' AND NEW.browser_approved_at_ms>=OLD.created_at_ms AND NEW.browser_approved_at_ms<OLD.expires_at_ms
 AND EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=NEW.browser_session_id AND s.user_id=OLD.user_id)))
BEGIN SELECT RAISE(ABORT,'oauth_intent_immutable'); END;
--> statement-breakpoint

CREATE UNIQUE INDEX payment_source_active_subscription ON payment_sources(subscription_id) WHERE retired_at_ms IS NULL;
--> statement-breakpoint

CREATE INDEX payment_sources_by_owner ON payment_sources(subscription_id);
--> statement-breakpoint

CREATE TRIGGER payment_source_requires_claim BEFORE INSERT ON payment_sources
WHEN NOT EXISTS(SELECT 1 FROM payment_enrollments e WHERE e.id=NEW.origin_enrollment_id
 AND e.subscription_id=NEW.subscription_id AND e.status IN('creating','verifying') AND e.payment_source_mode='create'
 AND e.wompi_candidate_source_id=NEW.wompi_source_id AND e.wompi_environment=NEW.wompi_environment
 AND e.method=NEW.method AND e.billing_email=NEW.billing_email AND NEW.retired_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT,'payment_source_invalid_claim'); END;
--> statement-breakpoint

CREATE TRIGGER payment_enrollment_source_guard BEFORE UPDATE OF payment_source_id ON payment_enrollments
WHEN NEW.payment_source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_sources p
 WHERE p.id=NEW.payment_source_id AND p.subscription_id=NEW.subscription_id
 AND p.method=NEW.method AND p.wompi_environment=NEW.wompi_environment AND p.retired_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT,'payment_enrollment_source_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER subscriptions_immutable BEFORE UPDATE ON subscriptions
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT,'subscription_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER payment_source_immutable BEFORE UPDATE ON payment_sources
WHEN NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id
 OR NEW.origin_enrollment_id IS NOT OLD.origin_enrollment_id OR NEW.wompi_environment IS NOT OLD.wompi_environment
 OR NEW.wompi_source_id IS NOT OLD.wompi_source_id OR NEW.billing_email IS NOT OLD.billing_email
 OR NEW.method IS NOT OLD.method OR NEW.verified_at_ms IS NOT OLD.verified_at_ms OR NEW.archive_row_ref IS NOT OLD.archive_row_ref
 OR (NEW.retired_at_ms IS NOT OLD.retired_at_ms AND (OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL  OR OLD.method<>'card'
  OR NOT EXISTS (SELECT 1 FROM billing_attempt_context a WHERE a.payment_source_id=OLD.id)
  OR EXISTS (SELECT 1 FROM (SELECT * FROM subscription_standing) sub WHERE sub.user_id=(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id))
  OR EXISTS (SELECT 1 FROM billing_attempt_context a WHERE a.payment_source_id=OLD.id
    AND (a.status<>'failed'
      OR EXISTS (SELECT 1 FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status IN ('PENDING','APPROVED'))
      OR (NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=a.id)
        AND NOT (a.no_charge_confirmed_at_ms IS NOT NULL AND a.no_charge_reference=a.wompi_reference AND a.no_charge_environment=a.wompi_environment))))))
BEGIN SELECT RAISE(ABORT,'payment_source_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_identities_insert BEFORE INSERT ON subscriptions WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_identities_update BEFORE UPDATE OF id,user_id ON subscriptions WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id OR NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_identities_delete BEFORE DELETE ON subscriptions WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_identities')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscription_identities_delete BEFORE DELETE ON subscriptions WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'subscription_identities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'id',OLD.id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_payment_sources_insert BEFORE INSERT ON payment_sources WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_payment_sources_update BEFORE UPDATE ON payment_sources WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id OR (SELECT user_id FROM subscriptions WHERE id=NEW.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_payment_sources_delete BEFORE DELETE ON payment_sources WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_payment_sources_delete BEFORE DELETE ON payment_sources WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'card_payment_sources','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.id,'user_id',(SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id),'enrollment_id',OLD.origin_enrollment_id,'wompi_source_id',OLD.wompi_source_id,'billing_email',OLD.billing_email,'created_at_ms',OLD.verified_at_ms,'method',OLD.method,'retired_at_ms',OLD.retired_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND (SELECT user_id FROM subscriptions WHERE id=OLD.subscription_id)=q.user_id AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER payment_source_bind_origin AFTER INSERT ON payment_sources
BEGIN UPDATE payment_enrollments SET payment_source_id=NEW.id WHERE id=NEW.origin_enrollment_id; END;
--> statement-breakpoint

CREATE TRIGGER payment_enrollment_source_insert_guard BEFORE INSERT ON payment_enrollments
WHEN NEW.payment_source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_sources p
 WHERE p.id=NEW.payment_source_id AND p.subscription_id=NEW.subscription_id
 AND p.method=NEW.method AND p.wompi_environment=NEW.wompi_environment AND p.retired_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT,'payment_enrollment_source_mismatch'); END;
--> statement-breakpoint

CREATE TRIGGER subscription_paid_attempt_guard BEFORE UPDATE OF current_paid_attempt_id ON subscriptions
WHEN NEW.current_paid_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM billing_attempt_context a WHERE a.id=NEW.current_paid_attempt_id AND a.subscription_id=NEW.id
 AND a.status='succeeded' AND a.paid_starts_at_ms IS NOT NULL
 AND (OLD.current_paid_attempt_id IS NULL OR OLD.current_paid_attempt_id=NEW.current_paid_attempt_id
 OR a.paid_ends_at_ms>(SELECT paid_ends_at_ms FROM billing_attempt_context WHERE id=OLD.current_paid_attempt_id)))
BEGIN SELECT RAISE(ABORT,'subscription_paid_attempt_invalid'); END;
--> statement-breakpoint

CREATE TRIGGER subscription_paid_attempt_initial BEFORE INSERT ON subscriptions
WHEN NEW.current_paid_attempt_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'subscription_paid_attempt_invalid'); END;
--> statement-breakpoint

CREATE VIEW billing_attempt_context AS SELECT a.rowid,a.*,s.user_id,
 p.amount,p.currency,p.billing_period,p.service_market,p.tax_treatment,
 CASE WHEN a.no_charge_confirmed_at_ms IS NOT NULL THEN a.wompi_reference END AS no_charge_reference,
 CASE WHEN a.no_charge_confirmed_at_ms IS NOT NULL THEN a.wompi_environment END AS no_charge_environment,
 CASE WHEN a.late_approval_observed_at_ms IS NOT NULL THEN a.no_charge_case_id END AS recovery_case_id,
 a.late_approval_observed_at_ms AS recovery_reviewed_at_ms
 FROM billing_attempts a JOIN subscriptions s ON s.id=a.subscription_id
 JOIN subscription_prices p ON p.id=a.price_id;
--> statement-breakpoint

CREATE TRIGGER subscription_paid_attempt_clear BEFORE UPDATE OF current_paid_attempt_id ON subscriptions
WHEN OLD.current_paid_attempt_id IS NOT NULL AND NEW.current_paid_attempt_id IS NULL AND NOT EXISTS (
 SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.user_id=OLD.user_id AND p.store_id='subscriptions' AND q.user_id=p.user_id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'subscription_paid_attempt_immutable'); END;
--> statement-breakpoint

CREATE INDEX billing_attempts_subscription_history ON billing_attempts(subscription_id,created_at_ms DESC,id DESC);
--> statement-breakpoint

CREATE INDEX billing_followup_due ON billing_attempts(followup_due_at_ms,id) WHERE followup_due_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE VIEW refund_charge_context AS
SELECT a.*,CAST(substr(a.amount,1,instr(a.amount||'.','.')-1) AS INTEGER)*100
  +CAST(substr(substr(a.amount,instr(a.amount||'.','.')+1)||'00',1,2) AS INTEGER) AS original_cents
FROM billing_attempt_context a
WHERE original_cents BETWEEN 1 AND 9007199254740991
  AND a.currency='COP' AND length(a.amount) BETWEEN 1 AND 17
  AND a.amount NOT GLOB '*[^0-9.]*'
  AND length(a.amount)-length(replace(a.amount,'.',''))<=1
  AND length(substr(a.amount,1,instr(a.amount||'.','.')-1)) BETWEEN 1 AND 14
  AND (instr(a.amount,'.')=0 OR length(a.amount)-instr(a.amount,'.') BETWEEN 1 AND 2)
  AND (length(substr(a.amount,1,instr(a.amount||'.','.')-1))=1 OR substr(a.amount,1,1)<>'0');
--> statement-breakpoint

CREATE VIEW refund_attempt_context AS
SELECT r.rowid,r.*,a.subscription_id,a.price_id,a.currency,a.original_cents,
 CASE WHEN r.access_ends_at_ms IS NOT NULL THEN r.billing_attempt_id END AS adjusted_attempt_id,
 CASE WHEN r.renewal_stopped_at_ms IS NOT NULL THEN r.user_id END AS renewal_stopped_user_id
FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id;
--> statement-breakpoint

CREATE VIEW billing_price_notice_context AS
SELECT n.rowid,n.*,s.user_id FROM billing_price_notices n JOIN subscriptions s ON s.id=n.subscription_id;
--> statement-breakpoint

CREATE INDEX billing_price_notices_pending ON billing_price_notices(last_offered_at_ms,created_at_ms,subscription_id) WHERE send_started_at_ms IS NULL;
--> statement-breakpoint

CREATE TRIGGER billing_price_notice_identity BEFORE UPDATE OF subscription_id,price_id,created_at_ms ON billing_price_notices
WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.price_id IS NOT OLD.price_id OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT,'billing_price_notice_identity'); END;
--> statement-breakpoint
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materializations_delete BEFORE DELETE ON statement_materializations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materializations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materializations_insert BEFORE INSERT ON statement_materializations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materializations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_statement_materializations_update BEFORE UPDATE ON statement_materializations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materializations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_statement_materializations_delete BEFORE DELETE ON statement_materializations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_materializations','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'source_sha256',OLD."source_sha256",'parts_sha256',OLD."parts_sha256",'representation_revision',OLD."representation_revision",'expires_at_ms',OLD."expires_at_ms",'headers_json',OLD."headers_json",'row_count',OLD."row_count",'part_count',OLD."part_count",'byte_length',OLD."byte_length",'state',OLD."state")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_clear BEFORE DELETE ON statement_materializations
WHEN EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=OLD.submission_id AND s.status NOT IN ('completed','failed')
 AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=s.user_id AND q.state NOT IN ('AwaitingReview','Draining'))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=s.user_id AND p.store_id='statement_materializations'))
BEGIN SELECT RAISE(ABORT,'statement_materialization_identity'); END;
--> statement-breakpoint

CREATE VIEW statement_review_context AS SELECT rowid,id,user_id,statement_submission_id AS submission_id,record_number,reason,original_evidence,known_money_json AS known_money,issues_json AS issues,CASE evidence_state WHEN 'retained' THEN 'pending' ELSE evidence_state END AS status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,suggestions_json AS review_suggestions_json FROM ingestion_review_items WHERE source_kind='statement';
--> statement-breakpoint

CREATE VIEW ingestion_review_workspace_state AS SELECT CAST(rowid AS TEXT) AS rowid,id,user_id,status,revision,draft_json,transaction_id,expires_at_ms,updated_at_ms,created_at_ms FROM ingestion_review_state
UNION ALL SELECT workspace_archive_row_ref,id,user_id,workspace_state,workspace_revision,draft_json,transaction_id,evidence_expires_at_ms,workspace_updated_at_ms,created_at_ms FROM ingestion_review_items WHERE workspace_updated_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX media_submissions_owned ON media_submissions(user_id,id);
--> statement-breakpoint

CREATE UNIQUE INDEX ingestion_statement_review_identity ON ingestion_review_items(id) WHERE source_kind='statement';
--> statement-breakpoint

CREATE INDEX ingestion_review_item_expiry ON ingestion_review_items(evidence_expires_at_ms,id);
--> statement-breakpoint

CREATE INDEX ingestion_review_item_history ON ingestion_review_items(created_at_ms,id) WHERE workspace_updated_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_item_workspace_insert BEFORE INSERT ON ingestion_review_items
WHEN NEW.workspace_updated_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_item_workspace_update BEFORE UPDATE ON ingestion_review_items
WHEN (NEW.workspace_state IS NOT OLD.workspace_state OR NEW.workspace_revision IS NOT OLD.workspace_revision OR NEW.draft_json IS NOT OLD.draft_json OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.workspace_updated_at_ms IS NOT OLD.workspace_updated_at_ms OR NEW.workspace_archive_row_ref IS NOT OLD.workspace_archive_row_ref) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_ingestion_review_item_workspace_delete BEFORE DELETE ON ingestion_review_items
WHEN OLD.workspace_updated_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_ingestion_review_item_workspace_update BEFORE UPDATE ON ingestion_review_items
WHEN OLD.workspace_updated_at_ms IS NOT NULL AND (NEW.workspace_state IS NOT OLD.workspace_state OR NEW.workspace_revision IS NOT OLD.workspace_revision OR NEW.draft_json IS NOT OLD.draft_json OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.workspace_updated_at_ms IS NOT OLD.workspace_updated_at_ms OR NEW.workspace_archive_row_ref IS NOT OLD.workspace_archive_row_ref) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."workspace_state",'revision',OLD."workspace_revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."evidence_expires_at_ms",'updated_at_ms',OLD."workspace_updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_ingestion_review_item_workspace_delete BEFORE DELETE ON ingestion_review_items
WHEN OLD.workspace_updated_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."workspace_state",'revision',OLD."workspace_revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."evidence_expires_at_ms",'updated_at_ms',OLD."workspace_updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER ingestion_review_item_initial BEFORE INSERT ON ingestion_review_items WHEN NEW.workspace_updated_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'review_workspace_initial'); END;

--> statement-breakpoint

CREATE TRIGGER ingestion_review_legacy_statement_insert BEFORE INSERT ON ingestion_review_state WHEN EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.user_id=NEW.user_id AND r.id=NEW.id) BEGIN SELECT RAISE(ABORT,'review_owner'); END;
--> statement-breakpoint

CREATE TRIGGER ingestion_review_legacy_statement_update BEFORE UPDATE ON ingestion_review_state WHEN EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.user_id=NEW.user_id AND r.id=NEW.id) BEGIN SELECT RAISE(ABORT,'review_owner'); END;
--> statement-breakpoint

CREATE TRIGGER ingestion_review_source_identity BEFORE INSERT ON ingestion_review_items WHEN EXISTS(SELECT 1 FROM ingestion_review_originals r WHERE r.user_id=NEW.user_id AND r.id=NEW.id) BEGIN SELECT RAISE(ABORT,'review_identity'); END;
