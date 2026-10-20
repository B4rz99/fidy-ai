PRAGMA defer_foreign_keys=ON;
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

CREATE TABLE _cleanup_statement_submissions AS SELECT rowid AS original_rowid,* FROM statement_submissions;
--> statement-breakpoint

CREATE TABLE _cleanup_hosted_turns AS SELECT rowid AS original_rowid,* FROM hosted_turns;
--> statement-breakpoint

CREATE TABLE _cleanup_statement_materialization_parts AS SELECT rowid AS original_rowid,* FROM statement_materialization_parts;
--> statement-breakpoint

CREATE TABLE _cleanup_hosted_mutation_commits AS SELECT rowid AS original_rowid,* FROM hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE statement_materialization_parts;
--> statement-breakpoint

DROP TABLE hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE statement_submissions;
--> statement-breakpoint

DROP TABLE hosted_turns;
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
    'malformed-file', 'mapping-unavailable', 'retention-expired')), source_parse_attempts INTEGER NOT NULL DEFAULT 0 CHECK(source_parse_attempts BETWEEN 0 AND 3), processed_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_rows>=0), processed_accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_accepted_rows>=0), processed_review_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_review_rows>=0), material_source_sha256 TEXT, material_parts_sha256 TEXT, material_parser_revision TEXT, material_source_format TEXT, material_representation_revision TEXT, material_service_market TEXT, material_locale TEXT, material_time_zone TEXT, material_expires_at_ms INTEGER, material_headers_json TEXT, material_row_count INTEGER, material_part_count INTEGER, material_byte_length INTEGER, material_state TEXT, hosted_session_id TEXT, hosted_turn_id TEXT, hosted_expires_at_ms INTEGER, hosted_abandoned_at_ms INTEGER, clarification_state TEXT, clarification_expires_at_ms INTEGER, clarification_ended_at_ms INTEGER, work_revision INTEGER, work_published_at_ms INTEGER, work_last_attempt_at_ms INTEGER, work_last_reconciled_at_ms INTEGER CHECK((work_revision IS NULL AND work_published_at_ms IS NULL AND work_last_attempt_at_ms IS NULL AND work_last_reconciled_at_ms IS NULL) OR (work_revision IS NOT NULL AND (work_revision = 1) AND work_published_at_ms IS NOT NULL AND (work_published_at_ms >= 0) AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms >= 0) AND (work_last_reconciled_at_ms IS NULL OR work_last_reconciled_at_ms >= 0))),
  UNIQUE (user_id, idempotency_key)
) STRICT;
--> statement-breakpoint

CREATE TABLE "hosted_turns" (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  hosted_session_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','interrupted')),
  failure_reason TEXT CHECK (failure_reason IN ('HostedInferenceFailed','HostedInferenceTimedOut','DeliveryFailed','DeliveryUnconfirmed')), proposal_receipt_digest BLOB, proposed_at_ms INTEGER, proposal_text TEXT, retention_terminal_at_ms INTEGER CHECK((proposed_at_ms IS NULL AND proposal_receipt_digest IS NULL AND proposal_text IS NULL) OR (proposed_at_ms IS NOT NULL AND proposal_receipt_digest IS NOT NULL AND (length(proposal_receipt_digest) = 32) AND proposal_text IS NOT NULL AND (length(proposal_text) > 0))), inbound_portfolio_id TEXT, inbound_bsuid TEXT, inbound_message_id TEXT, inbound_business_phone_number_id TEXT, inbound_occurred_at_ms INTEGER, inbound_received_at_ms INTEGER, inbound_reply_to_message_id TEXT, inbound_sandbox_phone TEXT, dispatch_user_id TEXT, dispatch_offered_at_ms INTEGER, dispatch_created_at_ms INTEGER CHECK((inbound_portfolio_id IS NULL AND inbound_bsuid IS NULL AND inbound_message_id IS NULL AND inbound_business_phone_number_id IS NULL AND inbound_occurred_at_ms IS NULL AND inbound_received_at_ms IS NULL AND inbound_reply_to_message_id IS NULL AND inbound_sandbox_phone IS NULL AND dispatch_user_id IS NULL AND dispatch_offered_at_ms IS NULL AND dispatch_created_at_ms IS NULL) OR (inbound_portfolio_id IS NOT NULL AND inbound_bsuid IS NOT NULL AND inbound_message_id IS NOT NULL AND inbound_business_phone_number_id IS NOT NULL AND inbound_occurred_at_ms IS NOT NULL AND inbound_received_at_ms IS NOT NULL)) CHECK(inbound_received_at_ms IS NULL OR inbound_received_at_ms>=inbound_occurred_at_ms-300000) CHECK((dispatch_created_at_ms IS NULL AND dispatch_user_id IS NULL AND dispatch_offered_at_ms IS NULL) OR (dispatch_created_at_ms IS NOT NULL AND dispatch_user_id=user_id)), document_media_id TEXT CHECK(document_media_id IS NULL OR length(document_media_id) BETWEEN 1 AND 256), document_staging_id TEXT REFERENCES statement_staging_objects(id), document_upload_grant_id TEXT CHECK(document_upload_grant_id IS NULL OR length(document_upload_grant_id) BETWEEN 1 AND 128), document_upload_expires_at_ms INTEGER CHECK(document_upload_expires_at_ms IS NULL OR document_upload_expires_at_ms>=0), document_reference_json TEXT CHECK(document_reference_json IS NULL OR (json_valid(document_reference_json) AND length(document_reference_json)<=4096)), document_created_at_ms INTEGER CHECK(document_created_at_ms IS NULL OR document_created_at_ms>=0) CHECK((document_media_id IS NULL AND document_staging_id IS NULL AND document_upload_grant_id IS NULL AND document_upload_expires_at_ms IS NULL AND document_reference_json IS NULL AND document_created_at_ms IS NULL) OR (document_media_id IS NOT NULL AND document_created_at_ms IS NOT NULL)) CHECK((document_upload_grant_id IS NULL)=(document_upload_expires_at_ms IS NULL)) CHECK((document_staging_id IS NULL)=(document_reference_json IS NULL)), inbound_turn_id TEXT GENERATED ALWAYS AS(CASE WHEN inbound_message_id IS NOT NULL THEN id END) VIRTUAL,
  FOREIGN KEY (user_id, hosted_session_id) REFERENCES hosted_agent_sessions(user_id, id),
  UNIQUE (user_id, id),
  CHECK ((status = 'pending' AND terminal_at_ms IS NULL AND failure_reason IS NULL) OR
         (status = 'failed' AND terminal_at_ms >= started_at_ms AND failure_reason IS NOT NULL) OR
         (status IN ('completed','interrupted') AND terminal_at_ms >= started_at_ms AND failure_reason IS NULL))
) STRICT;
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
  ON statement_submissions(work_last_attempt_at_ms, work_published_at_ms, id) WHERE work_revision IS NOT NULL;
--> statement-breakpoint

CREATE INDEX statement_ingestion_outbox_reconciliation
  ON statement_submissions(work_last_reconciled_at_ms, work_published_at_ms, id) WHERE work_revision IS NOT NULL;
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

INSERT INTO statement_submissions(rowid,"id","user_id","idempotency_key","staging_id","submitted_at_ms","source_format","parser_revision","service_market","locale","time_zone","status","started_at_ms","completed_at_ms","input_rows","accepted_rows","needs_review_rows","retention_expires_at_ms","failure_reason","source_parse_attempts","processed_rows","processed_accepted_rows","processed_review_rows","material_source_sha256","material_parts_sha256","material_parser_revision","material_source_format","material_representation_revision","material_service_market","material_locale","material_time_zone","material_expires_at_ms","material_headers_json","material_row_count","material_part_count","material_byte_length","material_state","hosted_session_id","hosted_turn_id","hosted_expires_at_ms","hosted_abandoned_at_ms","clarification_state","clarification_expires_at_ms","clarification_ended_at_ms","work_revision","work_published_at_ms","work_last_attempt_at_ms","work_last_reconciled_at_ms") SELECT original_rowid,"id","user_id","idempotency_key","staging_id","submitted_at_ms","source_format","parser_revision","service_market","locale","time_zone","status","started_at_ms","completed_at_ms","input_rows","accepted_rows","needs_review_rows","retention_expires_at_ms","failure_reason","source_parse_attempts","processed_rows","processed_accepted_rows","processed_review_rows","material_source_sha256","material_parts_sha256","material_parser_revision","material_source_format","material_representation_revision","material_service_market","material_locale","material_time_zone","material_expires_at_ms","material_headers_json","material_row_count","material_part_count","material_byte_length","material_state","hosted_session_id","hosted_turn_id","hosted_expires_at_ms","hosted_abandoned_at_ms","clarification_state","clarification_expires_at_ms","clarification_ended_at_ms","work_revision","work_published_at_ms","work_last_attempt_at_ms","work_last_reconciled_at_ms" FROM _cleanup_statement_submissions;
--> statement-breakpoint

INSERT INTO hosted_turns(rowid,"id","user_id","hosted_session_id","started_at_ms","terminal_at_ms","status","failure_reason","proposal_receipt_digest","proposed_at_ms","proposal_text","retention_terminal_at_ms","inbound_portfolio_id","inbound_bsuid","inbound_message_id","inbound_business_phone_number_id","inbound_occurred_at_ms","inbound_received_at_ms","inbound_reply_to_message_id","inbound_sandbox_phone","dispatch_user_id","dispatch_offered_at_ms","dispatch_created_at_ms","document_media_id","document_staging_id","document_upload_grant_id","document_upload_expires_at_ms","document_reference_json","document_created_at_ms") SELECT original_rowid,"id","user_id","hosted_session_id","started_at_ms","terminal_at_ms","status","failure_reason","proposal_receipt_digest","proposed_at_ms","proposal_text","retention_terminal_at_ms","inbound_portfolio_id","inbound_bsuid","inbound_message_id","inbound_business_phone_number_id","inbound_occurred_at_ms","inbound_received_at_ms","inbound_reply_to_message_id","inbound_sandbox_phone","dispatch_user_id","dispatch_offered_at_ms","dispatch_created_at_ms","document_media_id","document_staging_id","document_upload_grant_id","document_upload_expires_at_ms","document_reference_json","document_created_at_ms" FROM _cleanup_hosted_turns;
--> statement-breakpoint

INSERT INTO statement_materialization_parts(rowid,"submission_id","chunk_index","part_index","body","sha256") SELECT original_rowid,"submission_id","chunk_index","part_index","body","sha256" FROM _cleanup_statement_materialization_parts;
--> statement-breakpoint

INSERT INTO hosted_mutation_commits(rowid,"turn_id","tool_call_id","user_id","committed_at_ms","valid") SELECT original_rowid,"turn_id","tool_call_id","user_id","committed_at_ms","valid" FROM _cleanup_hosted_mutation_commits;
--> statement-breakpoint

DROP TABLE _cleanup_statement_submissions;
--> statement-breakpoint

DROP TABLE _cleanup_hosted_turns;
--> statement-breakpoint

DROP TABLE _cleanup_statement_materialization_parts;
--> statement-breakpoint

DROP TABLE _cleanup_hosted_mutation_commits;
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
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows",'material_source_sha256',OLD.material_source_sha256,'material_parts_sha256',OLD.material_parts_sha256,'material_parser_revision',OLD.material_parser_revision,'material_source_format',OLD.material_source_format,'material_representation_revision',OLD.material_representation_revision,'material_service_market',OLD.material_service_market,'material_locale',OLD.material_locale,'material_time_zone',OLD.material_time_zone,'material_expires_at_ms',OLD.material_expires_at_ms,'material_headers_json',OLD.material_headers_json,'material_row_count',OLD.material_row_count,'material_part_count',OLD.material_part_count,'material_byte_length',OLD.material_byte_length,'material_state',OLD.material_state,'hosted_session_id',OLD.hosted_session_id,'hosted_turn_id',OLD.hosted_turn_id,'hosted_expires_at_ms',OLD.hosted_expires_at_ms,'hosted_abandoned_at_ms',OLD.hosted_abandoned_at_ms,'clarification_state',OLD.clarification_state,'clarification_expires_at_ms',OLD.clarification_expires_at_ms,'clarification_ended_at_ms',OLD.clarification_ended_at_ms,'work_user_id',CASE WHEN OLD.work_revision IS NOT NULL THEN OLD.user_id END,'work_revision',OLD.work_revision,'work_published_at_ms',OLD.work_published_at_ms,'work_last_attempt_at_ms',OLD.work_last_attempt_at_ms,'work_last_reconciled_at_ms',OLD.work_last_reconciled_at_ms)
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
 AND (NEW.dispatch_user_id IS NOT NULL OR NEW.dispatch_offered_at_ms IS NOT NULL OR NEW.dispatch_created_at_ms IS NOT NULL)
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
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.id
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
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
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
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
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
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE turn_id = NEW.id))
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

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_update BEFORE UPDATE ON hosted_turns WHEN (NEW.inbound_portfolio_id IS NOT OLD.inbound_portfolio_id OR NEW.inbound_bsuid IS NOT OLD.inbound_bsuid OR NEW.inbound_message_id IS NOT OLD.inbound_message_id OR NEW.inbound_business_phone_number_id IS NOT OLD.inbound_business_phone_number_id OR NEW.inbound_occurred_at_ms IS NOT OLD.inbound_occurred_at_ms OR NEW.inbound_received_at_ms IS NOT OLD.inbound_received_at_ms OR NEW.inbound_reply_to_message_id IS NOT OLD.inbound_reply_to_message_id OR NEW.inbound_sandbox_phone IS NOT OLD.inbound_sandbox_phone OR NEW.dispatch_user_id IS NOT OLD.dispatch_user_id OR NEW.dispatch_offered_at_ms IS NOT OLD.dispatch_offered_at_ms OR NEW.dispatch_created_at_ms IS NOT OLD.dispatch_created_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_delete BEFORE DELETE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',OLD.dispatch_user_id,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_update BEFORE UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',OLD.dispatch_user_id,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;
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

CREATE TRIGGER statement_submissions_companions_initial BEFORE INSERT ON statement_submissions WHEN NEW.work_revision IS NOT NULL OR NEW.work_published_at_ms IS NOT NULL OR NEW.work_last_attempt_at_ms IS NOT NULL OR NEW.work_last_reconciled_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'statement_submissions_companions_initial'); END;
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

INSERT INTO sql_assertions(scope,accepted) SELECT 'column_cleanup_foreign_keys',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
--> statement-breakpoint

DELETE FROM sql_assertions WHERE scope='column_cleanup_foreign_keys';
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
