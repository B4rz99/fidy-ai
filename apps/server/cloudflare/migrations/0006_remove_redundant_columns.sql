PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

INSERT INTO sql_assertions(scope,accepted) SELECT 'column_owner',NOT EXISTS(SELECT 1 FROM hosted_turns WHERE dispatch_created_at_ms IS NOT NULL AND dispatch_user_id IS NOT user_id);
--> statement-breakpoint

DELETE FROM sql_assertions WHERE scope='column_owner';
--> statement-breakpoint

DROP INDEX "billing_access_by_period";
--> statement-breakpoint

DROP INDEX "billing_collection_work_due";
--> statement-breakpoint

DROP INDEX "billing_pending_health";
--> statement-breakpoint

DROP INDEX "billing_renewal_identity";
--> statement-breakpoint

DROP INDEX "connection_attempt_expiry";
--> statement-breakpoint

DROP INDEX "connection_attempt_retention";
--> statement-breakpoint

DROP INDEX "connection_one_pending_attempt";
--> statement-breakpoint

DROP INDEX "refunds_by_charge";
--> statement-breakpoint

DROP INDEX "refunds_by_user";
--> statement-breakpoint

DROP TRIGGER "billing_access_adjustment_immutable";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_snapshot_immutable";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_terminal_monotonic";
--> statement-breakpoint

DROP TRIGGER "billing_calendar_anchor_immutable";
--> statement-breakpoint

DROP TRIGGER "billing_checkout_response_no_update";
--> statement-breakpoint

DROP TRIGGER "billing_companions_initial";
--> statement-breakpoint

DROP TRIGGER "billing_followup_refund_stop";
--> statement-breakpoint

DROP TRIGGER "billing_history_no_delete";
--> statement-breakpoint

DROP TRIGGER "billing_no_charge_immutable_update";
--> statement-breakpoint

DROP TRIGGER "billing_no_charge_requires_sent_arm";
--> statement-breakpoint

DROP TRIGGER "billing_paid_period_immutable_update";
--> statement-breakpoint

DROP TRIGGER "billing_renewal_period_guard";
--> statement-breakpoint

DROP TRIGGER "billing_renewal_period_once";
--> statement-breakpoint

DROP TRIGGER "billing_renewal_snapshot_immutable";
--> statement-breakpoint

DROP TRIGGER "billing_renewal_success_fence";
--> statement-breakpoint

DROP TRIGGER "connection_attempt_transition";
--> statement-breakpoint

DROP TRIGGER "connection_preparation_binding";
--> statement-breakpoint

DROP TRIGGER "connection_preparation_immutable";
--> statement-breakpoint

DROP TRIGGER "connection_preparation_initial";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_attempts_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_attempts_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_connection_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_connection_attempts_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_connection_attempts_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_refund_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_refund_attempts_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_refund_attempts_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_connection_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_refund_attempts_delete";
--> statement-breakpoint

DROP TRIGGER "refund_acceptance_limit";
--> statement-breakpoint

DROP TRIGGER "refund_claim_immutable";
--> statement-breakpoint

DROP TRIGGER "refund_companions_initial";
--> statement-breakpoint

DROP TRIGGER "refund_evidence_immutable";
--> statement-breakpoint

DROP TRIGGER "refund_evidence_requires_claim";
--> statement-breakpoint

DROP TRIGGER "refund_no_delete";
--> statement-breakpoint

DROP TRIGGER "refund_snapshot_immutable";
--> statement-breakpoint

DROP TRIGGER "refund_verified_settlement";
--> statement-breakpoint

DROP TRIGGER "subscription_renewal_stop_immutable";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_billing_transition";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_detached_source";
--> statement-breakpoint

DROP TRIGGER "billing_followup_cancellation_stop";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_fence";
--> statement-breakpoint

DROP VIEW "subscription_renewal_fences";
--> statement-breakpoint

DROP VIEW "billing_retry_clearances";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_retired_source";
--> statement-breakpoint

DROP TRIGGER "billing_checkout_response_guard";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_provider_transactions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_provider_transactions_delete";
--> statement-breakpoint

DROP TRIGGER "payment_attempt_method_guard";
--> statement-breakpoint

DROP TRIGGER "refund_claim_requires_pending";
--> statement-breakpoint

DROP TRIGGER "refund_reservation_guard";
--> statement-breakpoint

DROP TRIGGER "weekly_price_notice";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_requires_claim";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_guard_insert";
--> statement-breakpoint

DROP TRIGGER "subscription_cancellation_guard";
--> statement-breakpoint

DROP TRIGGER "billing_attempt_user_collection_guard";
--> statement-breakpoint

DROP TRIGGER "card_source_immutable";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_billing_event_candidates_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_event_candidates_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_billing_event_candidates_update";
--> statement-breakpoint

DROP INDEX "hosted_mutation_commits_retention_user";
--> statement-breakpoint

DROP INDEX "hosted_turn_retention_due";
--> statement-breakpoint

DROP INDEX "hosted_turn_retention_user";
--> statement-breakpoint

DROP INDEX "hosted_turns_by_user_day";
--> statement-breakpoint

DROP INDEX "hosted_turns_by_user_session";
--> statement-breakpoint

DROP INDEX "hosted_turns_document_staging";
--> statement-breakpoint

DROP INDEX "hosted_turns_inbound_identity";
--> statement-breakpoint

DROP INDEX "hosted_turns_inbound_turn";
--> statement-breakpoint

DROP INDEX "hosted_turns_one_pending";
--> statement-breakpoint

DROP INDEX "hosted_turns_pending_due";
--> statement-breakpoint

DROP INDEX "hosted_whatsapp_outbox_offer";
--> statement-breakpoint

DROP INDEX "statement_clarification_deadline";
--> statement-breakpoint

DROP INDEX "statement_hosted_expiry";
--> statement-breakpoint

DROP INDEX "statement_hosted_session";
--> statement-breakpoint

DROP INDEX "statement_ingestion_outbox_attempt";
--> statement-breakpoint

DROP INDEX "statement_ingestion_outbox_reconciliation";
--> statement-breakpoint

DROP INDEX "statement_pending_health";
--> statement-breakpoint

DROP INDEX "statement_submissions_owned";
--> statement-breakpoint

DROP INDEX "statement_submissions_retention";
--> statement-breakpoint

DROP INDEX "statement_submissions_user_submitted";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_mutation_commits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_mutation_commits_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_mutation_commits_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_turns_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_turns_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_turns_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_materialization_parts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_materialization_parts_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_materialization_parts_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_submissions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_submissions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_statement_submissions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_hosted_mutation_commits_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_hosted_turns_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_statement_materialization_parts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_statement_submissions_delete";
--> statement-breakpoint

DROP TRIGGER "hosted_delivery_proposals_no_update";
--> statement-breakpoint

DROP TRIGGER "hosted_inbound_dispatch_initial";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_channel_append";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_channel_remove";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_mutation_append";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_mutation_remove";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_transcript_append";
--> statement-breakpoint

DROP TRIGGER "hosted_retention_transcript_remove";
--> statement-breakpoint

DROP TRIGGER "hosted_turn_daily_budget";
--> statement-breakpoint

DROP TRIGGER "hosted_turn_requires_consent";
--> statement-breakpoint

DROP TRIGGER "hosted_turn_retention_terminal";
--> statement-breakpoint

DROP TRIGGER "hosted_turns_begin_pending";
--> statement-breakpoint

DROP TRIGGER "hosted_turns_companions_initial";
--> statement-breakpoint

DROP TRIGGER "hosted_turns_terminal_evidence";
--> statement-breakpoint

DROP TRIGGER "hosted_turns_terminal_once";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_field_fence_delete";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_field_fence_insert";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_field_fence_update";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_inbound_immutable";
--> statement-breakpoint

DROP TRIGGER "statement_clarification_abandon";
--> statement-breakpoint

DROP TRIGGER "statement_clarification_release";
--> statement-breakpoint

DROP TRIGGER "statement_clarification_transition";
--> statement-breakpoint

DROP TRIGGER "statement_companions_valid_insert";
--> statement-breakpoint

DROP TRIGGER "statement_companions_valid_update";
--> statement-breakpoint

DROP TRIGGER "statement_document_immutable";
--> statement-breakpoint

DROP TRIGGER "statement_document_published";
--> statement-breakpoint

DROP TRIGGER "statement_document_same_user";
--> statement-breakpoint

DROP TRIGGER "statement_document_staging_deleted";
--> statement-breakpoint

DROP TRIGGER "statement_extraction_clarification";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_clear";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_identity";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_initial";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_owner";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_part_guard";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_part_immutable";
--> statement-breakpoint

DROP TRIGGER "statement_materialization_terminal";
--> statement-breakpoint

DROP TRIGGER "statement_origin_no_resumption";
--> statement-breakpoint

DROP TRIGGER "statement_partial_accounting_on_failure";
--> statement-breakpoint

DROP TRIGGER "statement_partial_backfill_on_failure";
--> statement-breakpoint

DROP TRIGGER "statement_progress";
--> statement-breakpoint

DROP TRIGGER "statement_progress_conservation";
--> statement-breakpoint

DROP TRIGGER "statement_progress_initial";
--> statement-breakpoint

DROP TRIGGER "statement_progress_order";
--> statement-breakpoint

DROP TRIGGER "statement_progress_terminal";
--> statement-breakpoint

DROP TRIGGER "statement_submission_state_insert";
--> statement-breakpoint

DROP TRIGGER "statement_submission_state_update";
--> statement-breakpoint

DROP TRIGGER "statement_submissions_companions_initial";
--> statement-breakpoint

DROP TRIGGER "statement_terminal_material";
--> statement-breakpoint

DROP TRIGGER "statement_whatsapp_documents_field_fence_delete";
--> statement-breakpoint

DROP TRIGGER "statement_whatsapp_documents_field_fence_insert";
--> statement-breakpoint

DROP TRIGGER "statement_whatsapp_documents_field_fence_update";
--> statement-breakpoint

DROP TRIGGER "statement_whatsapp_documents_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "statement_whatsapp_documents_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "transcript_retention_guard";
--> statement-breakpoint

CREATE TABLE _column_statement_submissions AS SELECT rowid AS original_rowid,* FROM statement_submissions;
--> statement-breakpoint

CREATE TABLE _column_refund_attempts AS SELECT rowid AS original_rowid,* FROM refund_attempts;
--> statement-breakpoint

CREATE TABLE _column_hosted_turns AS SELECT rowid AS original_rowid,* FROM hosted_turns;
--> statement-breakpoint

CREATE TABLE _column_connection_attempts AS SELECT rowid AS original_rowid,* FROM connection_attempts;
--> statement-breakpoint

CREATE TABLE _column_billing_attempts AS SELECT rowid AS original_rowid,* FROM billing_attempts;
--> statement-breakpoint

CREATE TABLE _column_statement_materialization_parts AS SELECT rowid AS original_rowid,* FROM statement_materialization_parts;
--> statement-breakpoint

CREATE TABLE _column_hosted_mutation_commits AS SELECT rowid AS original_rowid,* FROM hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE statement_materialization_parts;
--> statement-breakpoint

DROP TABLE billing_attempts;
--> statement-breakpoint

DROP TABLE connection_attempts;
--> statement-breakpoint

DROP TABLE hosted_turns;
--> statement-breakpoint

DROP TABLE refund_attempts;
--> statement-breakpoint

DROP TABLE statement_submissions;
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
    'malformed-file', 'mapping-unavailable', 'retention-expired')), source_parse_attempts INTEGER NOT NULL DEFAULT 0 CHECK(source_parse_attempts BETWEEN 0 AND 3), processed_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_rows>=0), processed_accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_accepted_rows>=0), processed_review_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_review_rows>=0), material_source_sha256 TEXT, material_parts_sha256 TEXT, material_parser_revision TEXT, material_source_format TEXT, material_representation_revision TEXT, material_service_market TEXT, material_locale TEXT, material_time_zone TEXT, material_expires_at_ms INTEGER, material_headers_json TEXT, material_row_count INTEGER, material_part_count INTEGER, material_byte_length INTEGER, material_state TEXT, hosted_session_id TEXT, hosted_turn_id TEXT, hosted_expires_at_ms INTEGER, hosted_abandoned_at_ms INTEGER, clarification_state TEXT, clarification_expires_at_ms INTEGER, clarification_ended_at_ms INTEGER, work_published_at_ms INTEGER, work_last_attempt_at_ms INTEGER, work_last_reconciled_at_ms INTEGER CHECK((work_published_at_ms IS NULL AND work_last_attempt_at_ms IS NULL AND work_last_reconciled_at_ms IS NULL) OR (work_published_at_ms IS NOT NULL AND (work_published_at_ms >= 0) AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms >= 0) AND (work_last_reconciled_at_ms IS NULL OR work_last_reconciled_at_ms >= 0))),
  UNIQUE (user_id, idempotency_key)
) STRICT;
--> statement-breakpoint

CREATE TABLE "refund_attempts" (
id TEXT PRIMARY KEY CHECK (length(id) = 36),
user_id TEXT NOT NULL REFERENCES users(id),
subscription_id TEXT NOT NULL REFERENCES users(subscription_id),
billing_attempt_id TEXT NOT NULL REFERENCES billing_attempts(id),
transaction_id TEXT NOT NULL REFERENCES billing_provider_transactions(evidence_transaction_id),
request_id TEXT NOT NULL CHECK (length(request_id) = 36),
intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
amount_in_cents INTEGER NOT NULL CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991),
original_cents INTEGER NOT NULL CHECK (original_cents BETWEEN 1 AND 9007199254740991),
kind TEXT NOT NULL CHECK (kind IN ('refund','card-void')),
operator_id TEXT NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 128),
created_at_ms INTEGER NOT NULL,
status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
progress TEXT NOT NULL DEFAULT 'queued' CHECK (progress IN ('queued','verifying','outcome-unknown')),
finalized_at_ms INTEGER,
failure TEXT CHECK (failure IN ('provider-declined','provider-cancelled','provider-refused')),
dispatch_last_attempt_at_ms INTEGER,
published_at_ms INTEGER,
verification_attempts INTEGER DEFAULT 0,
last_verification_at_ms INTEGER,
submission_claimed_at_ms INTEGER,
provider_refund_id TEXT UNIQUE,
verified_status TEXT,
observed_at_ms INTEGER,
adjusted_attempt_id TEXT REFERENCES billing_attempts(paid_attempt_id),
access_ends_at_ms INTEGER,
renewal_stopped_user_id TEXT REFERENCES users(id),
renewal_stopped_at_ms INTEGER,
UNIQUE (user_id,request_id),
CHECK ((status='pending' AND finalized_at_ms IS NULL AND failure IS NULL)
    OR (status='succeeded' AND finalized_at_ms IS NOT NULL AND failure IS NULL)
    OR (status='failed' AND finalized_at_ms IS NOT NULL AND failure IS NOT NULL)),
CHECK((dispatch_last_attempt_at_ms IS NULL AND published_at_ms IS NULL AND verification_attempts IS NULL AND last_verification_at_ms IS NULL) OR (verification_attempts IS NOT NULL AND (verification_attempts BETWEEN 0 AND 8))),
CHECK((submission_claimed_at_ms IS NULL AND submission_claimed_at_ms IS NULL) OR (submission_claimed_at_ms IS NOT NULL AND submission_claimed_at_ms IS NOT NULL)),
CHECK((verified_status IS NULL AND provider_refund_id IS NULL AND verified_status IS NULL AND observed_at_ms IS NULL) OR (verified_status IS NOT NULL AND (provider_refund_id IS NULL OR length(provider_refund_id) BETWEEN 1 AND 128) AND verified_status IS NOT NULL AND (verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED')) AND observed_at_ms IS NOT NULL)),
CHECK((adjusted_attempt_id IS NULL AND adjusted_attempt_id IS NULL AND access_ends_at_ms IS NULL) OR (adjusted_attempt_id IS NOT NULL AND adjusted_attempt_id IS NOT NULL AND access_ends_at_ms IS NOT NULL)),
CHECK((renewal_stopped_at_ms IS NULL AND renewal_stopped_user_id IS NULL AND renewal_stopped_at_ms IS NULL) OR (renewal_stopped_at_ms IS NOT NULL AND renewal_stopped_user_id IS NOT NULL AND renewal_stopped_at_ms IS NOT NULL))) STRICT;
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

CREATE TABLE "billing_attempts" (
id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
user_id TEXT NOT NULL REFERENCES users(id),
enrollment_id TEXT NOT NULL REFERENCES "card_enrollments"(id),
payment_request_id TEXT NOT NULL CHECK (length(payment_request_id) = 36),
payment_source_id TEXT NOT NULL REFERENCES "card_enrollments"(payment_source_id),
price_id TEXT NOT NULL REFERENCES subscription_prices(id),
amount TEXT NOT NULL,
currency TEXT NOT NULL CHECK (currency = 'COP'),
billing_period TEXT NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
service_market TEXT NOT NULL CHECK (service_market = 'CO'),
tax_treatment TEXT NOT NULL CHECK (tax_treatment = 'not-taxable'),
time_zone TEXT NOT NULL,
wompi_environment TEXT NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
wompi_reference TEXT NOT NULL UNIQUE,
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
followup_kind TEXT,
followup_due_at_ms INTEGER,
no_charge_reference TEXT,
no_charge_environment TEXT,
no_charge_case_id TEXT,
no_charge_operator_id TEXT,
no_charge_confirmed_at_ms INTEGER,
recovery_case_id TEXT,
recovery_reviewed_at_ms INTEGER,
paid_attempt_id TEXT GENERATED ALWAYS AS(CASE WHEN paid_starts_at_ms IS NOT NULL THEN id END) VIRTUAL UNIQUE,
UNIQUE (user_id, payment_request_id),
CHECK((paid_starts_at_ms IS NULL AND paid_starts_at_ms IS NULL AND paid_ends_at_ms IS NULL AND paid_renewal_anchor_ms IS NULL) OR (paid_starts_at_ms IS NOT NULL AND paid_starts_at_ms IS NOT NULL AND paid_ends_at_ms IS NOT NULL AND (paid_ends_at_ms > paid_starts_at_ms) AND paid_renewal_anchor_ms IS NOT NULL)),
CHECK((checkout_transaction_id IS NULL AND checkout_transaction_id IS NULL) OR (checkout_transaction_id IS NOT NULL AND checkout_transaction_id IS NOT NULL)),
CHECK((collection_state IS NULL AND collection_state IS NULL AND collection_sent_at_ms IS NULL AND collection_last_attempt_at_ms IS NULL) OR (collection_state IS NOT NULL AND collection_state IS NOT NULL AND (collection_state IN ('armed','sent','rejected')))),
CHECK((followup_kind IS NULL AND followup_kind IS NULL AND followup_due_at_ms IS NULL) OR (followup_kind IS NOT NULL AND followup_kind IS NOT NULL AND (followup_kind = 'renewal_due') AND followup_due_at_ms IS NOT NULL)),
CHECK((no_charge_confirmed_at_ms IS NULL AND no_charge_reference IS NULL AND no_charge_environment IS NULL AND no_charge_case_id IS NULL AND no_charge_operator_id IS NULL AND no_charge_confirmed_at_ms IS NULL) OR (no_charge_confirmed_at_ms IS NOT NULL AND no_charge_reference IS NOT NULL AND no_charge_environment IS NOT NULL AND no_charge_case_id IS NOT NULL AND (length(trim(no_charge_case_id)) BETWEEN 1 AND 128) AND no_charge_operator_id IS NOT NULL AND (length(trim(no_charge_operator_id)) BETWEEN 1 AND 128) AND no_charge_confirmed_at_ms IS NOT NULL AND (no_charge_confirmed_at_ms > 0))),
CHECK((recovery_case_id IS NULL AND recovery_case_id IS NULL AND recovery_reviewed_at_ms IS NULL) OR (recovery_case_id IS NOT NULL AND recovery_case_id IS NOT NULL AND recovery_reviewed_at_ms IS NOT NULL))) STRICT;
--> statement-breakpoint

CREATE TABLE "statement_materialization_parts" (
  submission_id TEXT NOT NULL REFERENCES statement_submissions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 624),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 1023),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(submission_id,chunk_index,part_index)
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

CREATE INDEX billing_access_by_period ON refund_attempts(adjusted_attempt_id,access_ends_at_ms) WHERE adjusted_attempt_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_collection_work_due ON billing_attempts(collection_last_attempt_at_ms,id) WHERE collection_state='armed' AND collection_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX billing_pending_health ON billing_attempts(created_at_ms) WHERE status = 'pending';
--> statement-breakpoint

CREATE UNIQUE INDEX billing_renewal_identity ON billing_attempts(previous_paid_attempt_id, renewal_attempt_number)
WHERE previous_paid_attempt_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX connection_attempt_expiry ON connection_attempts(user_id, expires_at_ms);
--> statement-breakpoint

CREATE INDEX connection_attempt_retention ON connection_attempts(expires_at_ms, id);
--> statement-breakpoint

CREATE UNIQUE INDEX connection_one_pending_attempt ON connection_attempts(user_id, connection_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX refunds_by_charge ON refund_attempts(billing_attempt_id,status);
--> statement-breakpoint

CREATE INDEX refunds_by_user ON refund_attempts(user_id,created_at_ms);
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

CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_turns(dispatch_offered_at_ms,dispatch_created_at_ms) WHERE dispatch_created_at_ms IS NOT NULL;
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

CREATE UNIQUE INDEX statement_submissions_owned ON statement_submissions(user_id, id);
--> statement-breakpoint

CREATE INDEX statement_submissions_retention
  ON statement_submissions(retention_expires_at_ms)
  WHERE status IN ('queued', 'processing');
--> statement-breakpoint

CREATE INDEX statement_submissions_user_submitted
  ON statement_submissions(user_id, submitted_at_ms);
--> statement-breakpoint

INSERT INTO statement_submissions(rowid,"id","user_id","idempotency_key","staging_id","submitted_at_ms","source_format","parser_revision","service_market","locale","time_zone","status","started_at_ms","completed_at_ms","input_rows","accepted_rows","needs_review_rows","retention_expires_at_ms","failure_reason","source_parse_attempts","processed_rows","processed_accepted_rows","processed_review_rows","material_source_sha256","material_parts_sha256","material_parser_revision","material_source_format","material_representation_revision","material_service_market","material_locale","material_time_zone","material_expires_at_ms","material_headers_json","material_row_count","material_part_count","material_byte_length","material_state","hosted_session_id","hosted_turn_id","hosted_expires_at_ms","hosted_abandoned_at_ms","clarification_state","clarification_expires_at_ms","clarification_ended_at_ms","work_published_at_ms","work_last_attempt_at_ms","work_last_reconciled_at_ms") SELECT original_rowid,"id","user_id","idempotency_key","staging_id","submitted_at_ms","source_format","parser_revision","service_market","locale","time_zone","status","started_at_ms","completed_at_ms","input_rows","accepted_rows","needs_review_rows","retention_expires_at_ms","failure_reason","source_parse_attempts","processed_rows","processed_accepted_rows","processed_review_rows","material_source_sha256","material_parts_sha256","material_parser_revision","material_source_format","material_representation_revision","material_service_market","material_locale","material_time_zone","material_expires_at_ms","material_headers_json","material_row_count","material_part_count","material_byte_length","material_state","hosted_session_id","hosted_turn_id","hosted_expires_at_ms","hosted_abandoned_at_ms","clarification_state","clarification_expires_at_ms","clarification_ended_at_ms","work_published_at_ms","work_last_attempt_at_ms","work_last_reconciled_at_ms" FROM _column_statement_submissions;
--> statement-breakpoint

INSERT INTO refund_attempts(rowid,"id","user_id","subscription_id","billing_attempt_id","transaction_id","request_id","intent_json","snapshot_json","amount_in_cents","original_cents","kind","operator_id","created_at_ms","status","progress","finalized_at_ms","failure","dispatch_last_attempt_at_ms","published_at_ms","verification_attempts","last_verification_at_ms","submission_claimed_at_ms","provider_refund_id","verified_status","observed_at_ms","adjusted_attempt_id","access_ends_at_ms","renewal_stopped_user_id","renewal_stopped_at_ms") SELECT original_rowid,"id","user_id","subscription_id","billing_attempt_id","transaction_id","request_id","intent_json","snapshot_json","amount_in_cents","original_cents","kind","operator_id","created_at_ms","status","progress","finalized_at_ms","failure","dispatch_last_attempt_at_ms","published_at_ms","verification_attempts","last_verification_at_ms","submission_claimed_at_ms","provider_refund_id","verified_status","observed_at_ms","adjusted_attempt_id","access_ends_at_ms","renewal_stopped_user_id","renewal_stopped_at_ms" FROM _column_refund_attempts;
--> statement-breakpoint

INSERT INTO hosted_turns(rowid,"id","user_id","hosted_session_id","started_at_ms","terminal_at_ms","status","failure_reason","proposal_receipt_digest","proposed_at_ms","proposal_text","retention_terminal_at_ms","inbound_portfolio_id","inbound_bsuid","inbound_message_id","inbound_business_phone_number_id","inbound_occurred_at_ms","inbound_received_at_ms","inbound_reply_to_message_id","inbound_sandbox_phone","dispatch_offered_at_ms","dispatch_created_at_ms","document_media_id","document_staging_id","document_upload_grant_id","document_upload_expires_at_ms","document_reference_json","document_created_at_ms") SELECT original_rowid,"id","user_id","hosted_session_id","started_at_ms","terminal_at_ms","status","failure_reason","proposal_receipt_digest","proposed_at_ms","proposal_text","retention_terminal_at_ms","inbound_portfolio_id","inbound_bsuid","inbound_message_id","inbound_business_phone_number_id","inbound_occurred_at_ms","inbound_received_at_ms","inbound_reply_to_message_id","inbound_sandbox_phone","dispatch_offered_at_ms","dispatch_created_at_ms","document_media_id","document_staging_id","document_upload_grant_id","document_upload_expires_at_ms","document_reference_json","document_created_at_ms" FROM _column_hosted_turns;
--> statement-breakpoint

INSERT INTO connection_attempts(rowid,"id","user_id","connection_id","institution_id","public_reference","status","created_at_ms","expires_at_ms","consumed_at_ms","prepared_session_id") SELECT original_rowid,"id","user_id","connection_id","institution_id","public_reference","status","created_at_ms","expires_at_ms","consumed_at_ms","prepared_session_id" FROM _column_connection_attempts;
--> statement-breakpoint

INSERT INTO billing_attempts(rowid,"id","user_id","enrollment_id","payment_request_id","payment_source_id","price_id","amount","currency","billing_period","service_market","tax_treatment","time_zone","wompi_environment","wompi_reference","status","created_at_ms","finalized_at_ms","previous_paid_attempt_id","period_starts_at_ms","period_ends_at_ms","calendar_anchor_ms","renewal_attempt_number","paid_starts_at_ms","paid_ends_at_ms","paid_renewal_anchor_ms","checkout_transaction_id","collection_state","collection_sent_at_ms","collection_last_attempt_at_ms","followup_kind","followup_due_at_ms","no_charge_reference","no_charge_environment","no_charge_case_id","no_charge_operator_id","no_charge_confirmed_at_ms","recovery_case_id","recovery_reviewed_at_ms") SELECT original_rowid,"id","user_id","enrollment_id","payment_request_id","payment_source_id","price_id","amount","currency","billing_period","service_market","tax_treatment","time_zone","wompi_environment","wompi_reference","status","created_at_ms","finalized_at_ms","previous_paid_attempt_id","period_starts_at_ms","period_ends_at_ms","calendar_anchor_ms","renewal_attempt_number","paid_starts_at_ms","paid_ends_at_ms","paid_renewal_anchor_ms","checkout_transaction_id","collection_state","collection_sent_at_ms","collection_last_attempt_at_ms","followup_kind","followup_due_at_ms","no_charge_reference","no_charge_environment","no_charge_case_id","no_charge_operator_id","no_charge_confirmed_at_ms","recovery_case_id","recovery_reviewed_at_ms" FROM _column_billing_attempts;
--> statement-breakpoint

INSERT INTO statement_materialization_parts(rowid,"submission_id","chunk_index","part_index","body","sha256") SELECT original_rowid,"submission_id","chunk_index","part_index","body","sha256" FROM _column_statement_materialization_parts;
--> statement-breakpoint

INSERT INTO hosted_mutation_commits(rowid,"turn_id","tool_call_id","user_id","committed_at_ms","valid") SELECT original_rowid,"turn_id","tool_call_id","user_id","committed_at_ms","valid" FROM _column_hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE _column_statement_submissions;
--> statement-breakpoint

DROP TABLE _column_refund_attempts;
--> statement-breakpoint

DROP TABLE _column_hosted_turns;
--> statement-breakpoint

DROP TABLE _column_connection_attempts;
--> statement-breakpoint

DROP TABLE _column_billing_attempts;
--> statement-breakpoint

DROP TABLE _column_statement_materialization_parts;
--> statement-breakpoint

DROP TABLE _column_hosted_mutation_commits;
--> statement-breakpoint

CREATE TRIGGER billing_access_adjustment_immutable BEFORE UPDATE OF adjusted_attempt_id,access_ends_at_ms ON refund_attempts
WHEN OLD.adjusted_attempt_id IS NOT NULL AND (NEW.adjusted_attempt_id IS NOT OLD.adjusted_attempt_id OR NEW.access_ends_at_ms IS NOT OLD.access_ends_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_access_adjustment_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_snapshot_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.user_id <> OLD.user_id OR NEW.enrollment_id <> OLD.enrollment_id
  OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.payment_source_id <> OLD.payment_source_id
  OR NEW.price_id <> OLD.price_id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
  OR NEW.billing_period <> OLD.billing_period OR NEW.service_market <> OLD.service_market
  OR NEW.tax_treatment <> OLD.tax_treatment OR NEW.time_zone <> OLD.time_zone
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

CREATE TRIGGER billing_calendar_anchor_immutable BEFORE UPDATE ON billing_attempts
WHEN NEW.calendar_anchor_ms IS NOT OLD.calendar_anchor_ms
BEGIN
 SELECT RAISE(ABORT, 'billing_calendar_anchor_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_checkout_response_no_update BEFORE UPDATE OF checkout_transaction_id ON billing_attempts
WHEN OLD.checkout_transaction_id IS NOT NULL AND (NEW.checkout_transaction_id IS NOT OLD.checkout_transaction_id) AND NOT(NEW.checkout_transaction_id IS NULL AND EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing'))
BEGIN
 SELECT RAISE(ABORT, 'billing_checkout_response_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_companions_initial BEFORE INSERT ON billing_attempts WHEN NEW.paid_starts_at_ms IS NOT NULL OR NEW.checkout_transaction_id IS NOT NULL OR NEW.followup_kind IS NOT NULL OR NEW.no_charge_confirmed_at_ms IS NOT NULL OR NEW.recovery_case_id IS NOT NULL OR NEW.collection_state IS NOT 'armed' OR NEW.collection_sent_at_ms IS NOT NULL OR NEW.collection_last_attempt_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'billing_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER billing_followup_refund_stop BEFORE UPDATE OF followup_kind,followup_due_at_ms ON billing_attempts
WHEN OLD.followup_kind IS NULL AND NEW.followup_kind IS NOT NULL AND (EXISTS (SELECT 1 FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) s JOIN billing_attempts a ON a.user_id=s.user_id
 WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER billing_history_no_delete BEFORE DELETE ON billing_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.user_id=OLD.user_id AND p.store_id='billing_history' AND q.user_id=p.user_id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'billing_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER billing_no_charge_immutable_update BEFORE UPDATE OF no_charge_reference,no_charge_environment,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NOT NULL AND (NEW.no_charge_reference IS NOT OLD.no_charge_reference OR NEW.no_charge_environment IS NOT OLD.no_charge_environment OR NEW.no_charge_case_id IS NOT OLD.no_charge_case_id OR NEW.no_charge_operator_id IS NOT OLD.no_charge_operator_id OR NEW.no_charge_confirmed_at_ms IS NOT OLD.no_charge_confirmed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'billing_no_charge_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER billing_no_charge_requires_sent_arm BEFORE UPDATE OF no_charge_reference,no_charge_environment,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms ON billing_attempts
WHEN OLD.no_charge_confirmed_at_ms IS NULL AND NEW.no_charge_confirmed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempts AS a
  JOIN (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) AS arm ON arm.attempt_id = a.id
  WHERE a.id = NEW.id AND a.wompi_reference = NEW.no_charge_reference
    AND a.wompi_environment = NEW.no_charge_environment AND a.status <> 'succeeded'
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
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempts a WHERE a.id = NEW.id
  AND a.previous_paid_attempt_id IS NOT NULL AND
    (NEW.paid_starts_at_ms <> a.period_starts_at_ms OR NEW.paid_ends_at_ms <> a.period_ends_at_ms
      OR NEW.paid_renewal_anchor_ms <> a.period_ends_at_ms)))
BEGIN
 SELECT RAISE(ABORT, 'billing_renewal_period_mismatch');
END;
--> statement-breakpoint

CREATE TRIGGER billing_renewal_period_once BEFORE UPDATE OF paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms ON billing_attempts
WHEN OLD.paid_starts_at_ms IS NULL AND NEW.paid_starts_at_ms IS NOT NULL AND (EXISTS (SELECT 1 FROM billing_attempts a JOIN billing_attempts sibling
  ON sibling.previous_paid_attempt_id = a.previous_paid_attempt_id
  JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) paid ON paid.attempt_id = sibling.id
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
    AND id IN (SELECT sibling.id FROM billing_attempts sibling JOIN billing_attempts success
      ON success.previous_paid_attempt_id=sibling.previous_paid_attempt_id WHERE success.id=NEW.id
      AND success.previous_paid_attempt_id IS NOT NULL);
END;
--> statement-breakpoint

CREATE TRIGGER connection_attempt_transition BEFORE UPDATE ON connection_attempts
WHEN OLD.status != 'pending' OR NEW.status = 'pending'
  OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.connection_id != OLD.connection_id
  OR NEW.institution_id != OLD.institution_id OR NEW.public_reference != OLD.public_reference
  OR NEW.created_at_ms != OLD.created_at_ms OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_attempt_transition'); END;
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

CREATE TRIGGER erasure_fence_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_attempts_insert BEFORE INSERT ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_attempts_update BEFORE UPDATE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history')) AND NOT (EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='billing_checkout_responses' AND p.user_id=OLD.user_id AND q.user_id=p.user_id AND q.state='Erasing') AND NEW.checkout_transaction_id IS NULL AND NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.enrollment_id IS OLD.enrollment_id AND NEW.payment_request_id IS OLD.payment_request_id AND NEW.payment_source_id IS OLD.payment_source_id AND NEW.price_id IS OLD.price_id AND NEW.amount IS OLD.amount AND NEW.currency IS OLD.currency AND NEW.billing_period IS OLD.billing_period AND NEW.service_market IS OLD.service_market AND NEW.tax_treatment IS OLD.tax_treatment AND NEW.time_zone IS OLD.time_zone AND NEW.wompi_environment IS OLD.wompi_environment AND NEW.wompi_reference IS OLD.wompi_reference AND NEW.status IS OLD.status AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.finalized_at_ms IS OLD.finalized_at_ms AND NEW.previous_paid_attempt_id IS OLD.previous_paid_attempt_id AND NEW.period_starts_at_ms IS OLD.period_starts_at_ms AND NEW.period_ends_at_ms IS OLD.period_ends_at_ms AND NEW.calendar_anchor_ms IS OLD.calendar_anchor_ms AND NEW.renewal_attempt_number IS OLD.renewal_attempt_number AND NEW.paid_starts_at_ms IS OLD.paid_starts_at_ms AND NEW.paid_ends_at_ms IS OLD.paid_ends_at_ms AND NEW.paid_renewal_anchor_ms IS OLD.paid_renewal_anchor_ms AND NEW.collection_state IS OLD.collection_state AND NEW.collection_sent_at_ms IS OLD.collection_sent_at_ms AND NEW.collection_last_attempt_at_ms IS OLD.collection_last_attempt_at_ms AND NEW.followup_kind IS OLD.followup_kind AND NEW.followup_due_at_ms IS OLD.followup_due_at_ms AND NEW.no_charge_reference IS OLD.no_charge_reference AND NEW.no_charge_environment IS OLD.no_charge_environment AND NEW.no_charge_case_id IS OLD.no_charge_case_id AND NEW.no_charge_operator_id IS OLD.no_charge_operator_id AND NEW.no_charge_confirmed_at_ms IS OLD.no_charge_confirmed_at_ms AND NEW.recovery_case_id IS OLD.recovery_case_id AND NEW.recovery_reviewed_at_ms IS OLD.recovery_reviewed_at_ms)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
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

CREATE TRIGGER erasure_preserve_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_history','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'enrollment_id',OLD."enrollment_id",'payment_request_id',OLD."payment_request_id",'payment_source_id',OLD."payment_source_id",'price_id',OLD."price_id",'amount',OLD."amount",'currency',OLD."currency",'billing_period',OLD."billing_period",'service_market',OLD."service_market",'tax_treatment',OLD."tax_treatment",'time_zone',OLD."time_zone",'wompi_environment',OLD."wompi_environment",'wompi_reference',OLD."wompi_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'finalized_at_ms',OLD."finalized_at_ms",'previous_paid_attempt_id',OLD."previous_paid_attempt_id",'period_starts_at_ms',OLD."period_starts_at_ms",'period_ends_at_ms',OLD."period_ends_at_ms",'attempt_number',1,'calendar_anchor_ms',OLD."calendar_anchor_ms",'renewal_attempt_number',OLD."renewal_attempt_number",'paid_starts_at_ms',OLD.paid_starts_at_ms,'paid_ends_at_ms',OLD.paid_ends_at_ms,'paid_renewal_anchor_ms',OLD.paid_renewal_anchor_ms,'checkout_transaction_id',OLD.checkout_transaction_id,'collection_state',OLD.collection_state,'collection_sent_at_ms',OLD.collection_sent_at_ms,'collection_last_attempt_at_ms',OLD.collection_last_attempt_at_ms,'followup_kind',OLD.followup_kind,'followup_due_at_ms',OLD.followup_due_at_ms,'no_charge_reference',OLD.no_charge_reference,'no_charge_environment',OLD.no_charge_environment,'no_charge_case_id',OLD.no_charge_case_id,'no_charge_operator_id',OLD.no_charge_operator_id,'no_charge_confirmed_at_ms',OLD.no_charge_confirmed_at_ms,'recovery_case_id',OLD.recovery_case_id,'recovery_reviewed_at_ms',OLD.recovery_reviewed_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
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

CREATE TRIGGER erasure_preserve_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'subscription_id',OLD."subscription_id",'billing_attempt_id',OLD."billing_attempt_id",'transaction_id',OLD."transaction_id",'request_id',OLD."request_id",'intent_json',OLD."intent_json",'snapshot_json',OLD."snapshot_json",'amount_in_cents',OLD."amount_in_cents",'original_cents',OLD."original_cents",'kind',OLD."kind",'operator_id',OLD."operator_id",'created_at_ms',OLD."created_at_ms",'status',OLD."status",'progress',OLD."progress",'finalized_at_ms',OLD."finalized_at_ms",'failure',OLD."failure",'work_version',CASE WHEN OLD.verification_attempts IS NOT NULL THEN 1 END,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'published_at_ms',OLD.published_at_ms,'verification_attempts',OLD.verification_attempts,'last_verification_at_ms',OLD.last_verification_at_ms,'submission_claimed_at_ms',OLD.submission_claimed_at_ms,'provider_refund_id',OLD.provider_refund_id,'verified_status',OLD.verified_status,'observed_at_ms',OLD.observed_at_ms,'adjusted_attempt_id',OLD.adjusted_attempt_id,'access_ends_at_ms',OLD.access_ends_at_ms,'renewal_stopped_user_id',OLD.renewal_stopped_user_id,'renewal_stopped_at_ms',OLD.renewal_stopped_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
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

CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.published_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.adjusted_attempt_id IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END;
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

CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.subscription_id<>OLD.subscription_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.snapshot_json<>OLD.snapshot_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents OR NEW.original_cents<>OLD.original_cents
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
 UPDATE refund_attempts SET adjusted_attempt_id=incoming.attempt_id,access_ends_at_ms=incoming.ends_at_ms FROM (SELECT id AS refund_id,billing_attempt_id AS attempt_id,NEW.observed_at_ms AS ends_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.adjusted_attempt_id IS NULL;
 UPDATE refund_attempts SET renewal_stopped_user_id=incoming.user_id,renewal_stopped_at_ms=incoming.stopped_at_ms FROM (SELECT id AS refund_id,user_id AS user_id,NEW.observed_at_ms AS stopped_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.renewal_stopped_at_ms IS NULL;
 UPDATE billing_attempts AS billing_followup_outbox SET followup_kind=NULL,followup_due_at_ms=NULL WHERE followup_kind IS NOT NULL AND id IN
    (SELECT a.id FROM billing_attempts a JOIN refund_attempts r ON r.user_id=a.user_id
      WHERE r.id=NEW.id AND r.status='succeeded');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_renewal_stop_immutable BEFORE UPDATE OF renewal_stopped_user_id,renewal_stopped_at_ms ON refund_attempts
WHEN OLD.renewal_stopped_at_ms IS NOT NULL AND (NEW.renewal_stopped_user_id IS NOT OLD.renewal_stopped_user_id OR NEW.renewal_stopped_at_ms IS NOT OLD.renewal_stopped_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_audit_entries_delete BEFORE DELETE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id
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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
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
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id
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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
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
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND (COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id OR COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id)
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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_billing_transition BEFORE DELETE ON audit_entries
WHEN OLD.record_type='billing_transition' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_audit','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'transition',OLD."transition",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_detached_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) WHERE payment_source_id=NEW.payment_source_id)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_detached');
END;
--> statement-breakpoint

CREATE TRIGGER billing_followup_cancellation_stop BEFORE UPDATE OF followup_kind,followup_due_at_ms ON billing_attempts
WHEN OLD.followup_kind IS NULL AND NEW.followup_kind IS NOT NULL AND (EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) c JOIN billing_attempts a ON a.user_id=c.user_id WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_fence AFTER UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NULL AND NEW.cancellation_cancelled_at_ms IS NOT NULL
BEGIN
 UPDATE billing_attempts AS billing_followup_outbox SET followup_kind=NULL,followup_due_at_ms=NULL WHERE followup_kind IS NOT NULL AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.id);
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed'
    AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.id);
END;
--> statement-breakpoint

CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL);
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

CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_enrollments WHEN OLD.payment_source_id IS NOT NULL AND (NEW.source_row_ref IS NOT OLD.source_row_ref OR NEW.payment_source_id IS NOT OLD.payment_source_id OR NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id OR NEW.source_wompi_id IS NOT OLD.source_wompi_id OR NEW.source_billing_email IS NOT OLD.source_billing_email OR NEW.source_created_at_ms IS NOT OLD.source_created_at_ms OR NEW.source_retired_at_ms IS NOT OLD.source_retired_at_ms OR NEW.source_method IS NOT OLD.source_method) AND NOT(NEW.payment_source_id IS NULL) AND (NEW.payment_source_id<>OLD.payment_source_id OR NEW.user_id<>OLD.user_id OR NEW.id<>OLD.id
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
        AND NOT (a.no_charge_confirmed_at_ms IS NOT NULL AND a.no_charge_reference=a.wompi_reference AND a.no_charge_environment=a.wompi_environment)))) OR NEW.source_row_ref IS NOT OLD.source_row_ref) BEGIN SELECT RAISE(ABORT,'card_source_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_insert BEFORE INSERT ON billing_provider_transactions WHEN NEW.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_delete BEFORE DELETE ON billing_provider_transactions WHEN OLD.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_billing_event_candidates_update BEFORE UPDATE ON billing_provider_transactions WHEN (OLD.event_received_at_ms IS NOT NULL OR NEW.event_received_at_ms IS NOT NULL) AND (NEW.transaction_id IS NOT OLD.transaction_id OR NEW.event_row_ref IS NOT OLD.event_row_ref OR NEW.event_received_at_ms IS NOT OLD.event_received_at_ms OR NEW.event_signed_at IS NOT OLD.event_signed_at OR NEW.event_signed_status IS NOT OLD.event_signed_status OR NEW.event_lookup_attempts IS NOT OLD.event_lookup_attempts OR NEW.event_last_checked_at_ms IS NOT OLD.event_last_checked_at_ms OR NEW.event_resolved_at_ms IS NOT OLD.event_resolved_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=OLD.attempt_id AND OLD.status IS NOT NULL AND a.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM billing_attempts a WHERE a.id=NEW.attempt_id AND NEW.status IS NOT NULL AND a.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_event_candidates')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
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

CREATE TRIGGER erasure_preserve_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows",'material_source_sha256',OLD.material_source_sha256,'material_parts_sha256',OLD.material_parts_sha256,'material_parser_revision',OLD.material_parser_revision,'material_source_format',OLD.material_source_format,'material_representation_revision',OLD.material_representation_revision,'material_service_market',OLD.material_service_market,'material_locale',OLD.material_locale,'material_time_zone',OLD.material_time_zone,'material_expires_at_ms',OLD.material_expires_at_ms,'material_headers_json',OLD.material_headers_json,'material_row_count',OLD.material_row_count,'material_part_count',OLD.material_part_count,'material_byte_length',OLD.material_byte_length,'material_state',OLD.material_state,'hosted_session_id',OLD.hosted_session_id,'hosted_turn_id',OLD.hosted_turn_id,'hosted_expires_at_ms',OLD.hosted_expires_at_ms,'hosted_abandoned_at_ms',OLD.hosted_abandoned_at_ms,'clarification_state',OLD.clarification_state,'clarification_expires_at_ms',OLD.clarification_expires_at_ms,'clarification_ended_at_ms',OLD.clarification_ended_at_ms,'work_user_id',CASE WHEN OLD.work_published_at_ms IS NOT NULL THEN OLD.user_id END,'work_revision',CASE WHEN OLD.work_published_at_ms IS NOT NULL THEN 1 END,'work_published_at_ms',OLD.work_published_at_ms,'work_last_attempt_at_ms',OLD.work_last_attempt_at_ms,'work_last_reconciled_at_ms',OLD.work_last_reconciled_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
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

CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='abandoned'
BEGIN
 INSERT INTO ingestion_review_state(id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms)
 SELECT r.id,r.user_id,'abandoned',1,r.evidence_expires_at_ms,NEW.clarification_ended_at_ms,r.created_at_ms
 FROM statement_needs_review r WHERE r.submission_id=NEW.id
 AND NOT EXISTS(SELECT 1 FROM ingestion_review_state n WHERE n.id=r.id AND n.user_id=r.user_id AND n.status!='pending')
 ON CONFLICT(user_id,id) DO UPDATE SET status='abandoned',revision=revision+1,draft_json=NULL,updated_at_ms=excluded.updated_at_ms;
 UPDATE statement_needs_review SET status='expired',original_evidence=NULL,known_money=NULL,review_suggestions_json=NULL
 WHERE submission_id=NEW.id AND status='pending' AND EXISTS
 (SELECT 1 FROM ingestion_review_state n WHERE n.id=statement_needs_review.id AND n.user_id=NEW.user_id AND n.status='abandoned');
 UPDATE users SET backfill_submission_id=NULL
 WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.id AND backfill_consumed_at_ms IS NULL;
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

CREATE TRIGGER statement_companions_valid_insert BEFORE INSERT ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN
 SELECT RAISE(ABORT,'statement_companions_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER statement_companions_valid_update BEFORE UPDATE ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN
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
 UPDATE statement_submissions SET clarification_state='awaiting',clarification_expires_at_ms=(SELECT min(evidence_expires_at_ms) FROM statement_needs_review WHERE submission_id=NEW.id),clarification_ended_at_ms=NULL WHERE id=NEW.id;
 UPDATE statement_submissions SET clarification_state='abandoned',clarification_ended_at_ms=NEW.completed_at_ms WHERE id=NEW.id AND clarification_expires_at_ms<=NEW.completed_at_ms;
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_clear BEFORE UPDATE OF material_state ON statement_submissions WHEN OLD.material_state IS NOT NULL AND NEW.material_state IS NULL AND NEW.status NOT IN ('completed','failed') BEGIN
 SELECT RAISE(ABORT,'statement_materialization_identity');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_identity BEFORE UPDATE OF material_source_sha256,material_parts_sha256,material_parser_revision,material_source_format,material_representation_revision,material_service_market,material_locale,material_time_zone,material_expires_at_ms,material_headers_json,material_row_count,material_part_count,material_byte_length,material_state ON statement_submissions
WHEN OLD.material_state IS NOT NULL AND NEW.material_state IS NOT NULL AND (NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
  OR NEW.material_source_sha256<>OLD.material_source_sha256 OR NEW.material_parser_revision<>OLD.material_parser_revision
  OR NEW.material_parts_sha256<>OLD.material_parts_sha256
  OR NEW.material_source_format<>OLD.material_source_format OR NEW.material_expires_at_ms<>OLD.material_expires_at_ms
  OR NEW.material_representation_revision<>OLD.material_representation_revision
  OR NEW.material_service_market<>OLD.material_service_market OR NEW.material_locale<>OLD.material_locale OR NEW.material_time_zone<>OLD.material_time_zone
  OR NEW.material_headers_json<>OLD.material_headers_json OR NEW.material_row_count<>OLD.material_row_count
  OR NEW.material_part_count<>OLD.material_part_count OR NEW.material_byte_length<>OLD.material_byte_length OR OLD.material_state='ready'
)
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_identity');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_initial BEFORE INSERT ON statement_submissions
WHEN NEW.material_state IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_owner');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_owner BEFORE UPDATE OF material_state ON statement_submissions
WHEN OLD.material_state IS NULL AND NEW.material_state IS NOT NULL AND NOT EXISTS (SELECT 1 FROM statement_submissions s JOIN statement_staging_objects o
  ON o.id=s.staging_id AND o.user_id=s.user_id
  WHERE s.id=NEW.id AND s.user_id=NEW.user_id AND s.status IN ('queued','processing')
    AND s.parser_revision=NEW.material_parser_revision AND s.source_format=NEW.material_source_format
    AND s.service_market=NEW.material_service_market AND s.locale=NEW.material_locale AND s.time_zone=NEW.material_time_zone
    AND o.sha256=NEW.material_source_sha256 AND s.retention_expires_at_ms=NEW.material_expires_at_ms)
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_owner');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_part_guard BEFORE INSERT ON statement_materialization_parts
WHEN NOT EXISTS (SELECT 1 FROM statement_submissions m WHERE m.id=NEW.submission_id
  AND m.material_state='building' AND m.status IN ('queued','processing'))
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_part_guard');
END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_part_immutable BEFORE UPDATE ON statement_materialization_parts
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER statement_materialization_terminal AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed')
BEGIN
 DELETE FROM statement_materialization_parts WHERE submission_id=NEW.id;
 UPDATE statement_submissions SET material_source_sha256=NULL,material_parts_sha256=NULL,material_parser_revision=NULL,material_source_format=NULL,material_representation_revision=NULL,material_service_market=NULL,material_locale=NULL,material_time_zone=NULL,material_expires_at_ms=NULL,material_headers_json=NULL,material_row_count=NULL,material_part_count=NULL,material_byte_length=NULL,material_state=NULL WHERE id=NEW.id AND material_state IS NOT NULL;
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

INSERT INTO sql_assertions(scope,accepted) SELECT 'column_integrity',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
--> statement-breakpoint

DELETE FROM sql_assertions WHERE scope='column_integrity';
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
