PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS hosted_turns_begin_pending;

DROP TRIGGER IF EXISTS hosted_turns_terminal_once;

DROP TRIGGER IF EXISTS hosted_turn_daily_budget;

DROP TRIGGER IF EXISTS hosted_delivery_proposals_no_update;

DROP TRIGGER IF EXISTS hosted_whatsapp_inbound_no_update;

DROP TRIGGER IF EXISTS hosted_turn_retention_terminal;

DROP TRIGGER IF EXISTS hosted_retention_transcript_append;

DROP TRIGGER IF EXISTS hosted_retention_mutation_append;

DROP TRIGGER IF EXISTS hosted_retention_channel_append;

DROP TRIGGER IF EXISTS statement_progress_order;

DROP TRIGGER IF EXISTS statement_progress;

DROP TRIGGER IF EXISTS transcript_retention_guard;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outbox_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_agent_sessions_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_agent_sessions_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_agent_sessions_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_compacted_conversations_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_compacted_conversations_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_compacted_conversations_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_delivery_proposals_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_delivery_proposals_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_delivery_proposals_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turn_retention_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turn_retention_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turn_retention_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turns_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turns_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_turns_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_inbound_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_inbound_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_inbound_delete;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_hosted_whatsapp_outbox_delete;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_scans_insert;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_scans_update;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_scans_delete;

DROP TRIGGER IF EXISTS erasure_fence_statement_ingestion_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_ingestion_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_ingestion_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_recurring_digest_scans_delete;

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_ingestion_outbox_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_agent_sessions_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_compacted_conversations_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_delivery_proposals_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_turn_retention_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_turns_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_whatsapp_inbound_delete;

DROP TRIGGER IF EXISTS erasure_preserve_hosted_whatsapp_outbox_delete;

DROP TRIGGER IF EXISTS hosted_retention_transcript_remove;

DROP TRIGGER IF EXISTS hosted_retention_mutation_remove;

DROP TRIGGER IF EXISTS hosted_retention_channel_remove;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_instructions_insert;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_instructions_update;

DROP TRIGGER IF EXISTS erasure_fence_recurring_digest_instructions_delete;

DROP TRIGGER IF EXISTS erasure_preserve_recurring_digest_instructions_delete;

DROP TRIGGER IF EXISTS statement_submission_state_insert;

DROP TRIGGER IF EXISTS statement_submission_state_update;

DROP TRIGGER IF EXISTS statement_partial_backfill_on_failure;

DROP TRIGGER IF EXISTS statement_origin_no_resumption;

DROP TRIGGER IF EXISTS statement_document_published;

DROP TRIGGER IF EXISTS statement_terminal_material;

DROP TRIGGER IF EXISTS statement_materialization_owner;

DROP TRIGGER IF EXISTS statement_materialization_identity;

DROP TRIGGER IF EXISTS statement_materialization_part_guard;

DROP TRIGGER IF EXISTS statement_progress_initial;

DROP TRIGGER IF EXISTS statement_progress_conservation;

DROP TRIGGER IF EXISTS statement_progress_terminal;

DROP TRIGGER IF EXISTS statement_partial_accounting_on_failure;

DROP TRIGGER IF EXISTS erasure_fence_statement_submissions_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_submissions_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_submissions_delete;

DROP TRIGGER IF EXISTS erasure_fence_statement_materialization_parts_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_materialization_parts_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_materialization_parts_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_materialization_parts_delete;

DROP TRIGGER IF EXISTS statement_clarification_transition;

DROP TRIGGER IF EXISTS statement_clarification_abandon;

DROP TRIGGER IF EXISTS statement_clarification_release;

DROP TRIGGER IF EXISTS erasure_preserve_statement_submissions_delete;

DROP TRIGGER IF EXISTS statement_materialization_terminal;

DROP TRIGGER IF EXISTS statement_extraction_clarification;

DROP TRIGGER IF EXISTS statement_companions_valid_insert;

DROP TRIGGER IF EXISTS statement_companions_valid_update;

DROP TRIGGER IF EXISTS statement_materialization_clear;

DROP TRIGGER IF EXISTS statement_materialization_initial;

DROP TRIGGER IF EXISTS forwarded_email_capacity;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_insert;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_delete;

DROP TRIGGER IF EXISTS forwarded_email_deferred_capacity_insert;

DROP TRIGGER IF EXISTS forwarded_email_deferred_capacity_update;

DROP TRIGGER IF EXISTS forwarded_email_deferred_expiry;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_update;

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_receipts_delete;

DROP TRIGGER IF EXISTS forwarded_email_outcome_no_update;

DROP TRIGGER IF EXISTS forwarded_email_review_no_update;

DROP TRIGGER IF EXISTS forwarded_email_companions_valid_insert;

DROP TRIGGER IF EXISTS forwarded_email_companions_valid_update;

DROP TRIGGER IF EXISTS forwarded_email_completion_initial;

DROP TRIGGER IF EXISTS forwarded_email_completed_no_delete;

DROP TRIGGER IF EXISTS hosted_turn_requires_consent;

DROP TRIGGER IF EXISTS forwarded_email_authority;

DROP TRIGGER IF EXISTS forwarded_email_publication_authority;

DROP TRIGGER IF EXISTS forwarded_email_outcome_consent;

DROP TRIGGER IF EXISTS hosted_turns_terminal_evidence;

DROP VIEW IF EXISTS ingestion_review_originals;

DROP VIEW IF EXISTS ingestion_review_sources;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_digest_scan_owner',NOT EXISTS(SELECT 1 FROM recurring_digest_scans s LEFT JOIN recurring_digest_instructions i USING(user_id) WHERE i.user_id IS NULL);

DELETE FROM sql_assertions WHERE scope='migration_digest_scan_owner';

ALTER TABLE hosted_turns ADD COLUMN proposal_user_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN proposal_receipt_digest BLOB;

ALTER TABLE hosted_turns ADD COLUMN proposed_at_ms INTEGER;

ALTER TABLE hosted_turns ADD COLUMN proposal_text TEXT;

ALTER TABLE hosted_turns ADD COLUMN retention_user_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN retention_terminal_at_ms INTEGER CHECK((proposed_at_ms IS NULL AND proposal_user_id IS NULL AND proposal_receipt_digest IS NULL AND proposed_at_ms IS NULL AND proposal_text IS NULL) OR (proposed_at_ms IS NOT NULL AND proposal_user_id IS NOT NULL AND proposal_receipt_digest IS NOT NULL AND (length(proposal_receipt_digest) = 32) AND proposed_at_ms IS NOT NULL AND proposal_text IS NOT NULL AND (length(proposal_text) > 0))) CHECK((retention_terminal_at_ms IS NULL AND retention_user_id IS NULL AND retention_terminal_at_ms IS NULL) OR (retention_terminal_at_ms IS NOT NULL AND retention_user_id IS NOT NULL AND retention_terminal_at_ms IS NOT NULL)) CHECK(proposal_user_id IS NULL OR proposal_user_id=user_id) CHECK(retention_user_id IS NULL OR retention_user_id=user_id);

UPDATE hosted_turns SET proposal_user_id=(SELECT user_id FROM hosted_delivery_proposals WHERE turn_id=hosted_turns.id),proposal_receipt_digest=(SELECT receipt_digest FROM hosted_delivery_proposals WHERE turn_id=hosted_turns.id),proposed_at_ms=(SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id=hosted_turns.id),proposal_text=(SELECT text FROM hosted_delivery_proposals WHERE turn_id=hosted_turns.id),retention_user_id=(SELECT user_id FROM hosted_turn_retention WHERE turn_id=hosted_turns.id),retention_terminal_at_ms=(SELECT terminal_at_ms FROM hosted_turn_retention WHERE turn_id=hosted_turns.id);

ALTER TABLE hosted_agent_sessions ADD COLUMN compacted_text TEXT;

ALTER TABLE hosted_agent_sessions ADD COLUMN compacted_through_sequence INTEGER;

ALTER TABLE hosted_agent_sessions ADD COLUMN compacted_revision INTEGER;

ALTER TABLE hosted_agent_sessions ADD COLUMN compacted_nonce TEXT;

ALTER TABLE hosted_agent_sessions ADD COLUMN compacted_at_ms INTEGER CHECK((compacted_revision IS NULL AND compacted_text IS NULL AND compacted_through_sequence IS NULL AND compacted_revision IS NULL AND compacted_nonce IS NULL AND compacted_at_ms IS NULL) OR (compacted_revision IS NOT NULL AND compacted_text IS NOT NULL AND (length(compacted_text) > 0) AND compacted_through_sequence IS NOT NULL AND (compacted_through_sequence >= 0) AND compacted_revision IS NOT NULL AND (compacted_revision > 0) AND compacted_nonce IS NOT NULL AND compacted_at_ms IS NOT NULL));

UPDATE hosted_agent_sessions SET compacted_text=(SELECT text FROM hosted_compacted_conversations WHERE user_id=hosted_agent_sessions.user_id AND hosted_session_id=hosted_agent_sessions.id),compacted_through_sequence=(SELECT through_sequence FROM hosted_compacted_conversations WHERE user_id=hosted_agent_sessions.user_id AND hosted_session_id=hosted_agent_sessions.id),compacted_revision=(SELECT revision FROM hosted_compacted_conversations WHERE user_id=hosted_agent_sessions.user_id AND hosted_session_id=hosted_agent_sessions.id),compacted_nonce=(SELECT nonce FROM hosted_compacted_conversations WHERE user_id=hosted_agent_sessions.user_id AND hosted_session_id=hosted_agent_sessions.id),compacted_at_ms=(SELECT updated_at_ms FROM hosted_compacted_conversations WHERE user_id=hosted_agent_sessions.user_id AND hosted_session_id=hosted_agent_sessions.id);

ALTER TABLE hosted_whatsapp_inbound ADD COLUMN dispatch_user_id TEXT;

ALTER TABLE hosted_whatsapp_inbound ADD COLUMN dispatch_offered_at_ms INTEGER;

ALTER TABLE hosted_whatsapp_inbound ADD COLUMN dispatch_created_at_ms INTEGER CHECK((dispatch_created_at_ms IS NULL AND dispatch_user_id IS NULL AND dispatch_offered_at_ms IS NULL AND dispatch_created_at_ms IS NULL) OR (dispatch_created_at_ms IS NOT NULL AND dispatch_user_id IS NOT NULL AND dispatch_created_at_ms IS NOT NULL)) CHECK(dispatch_user_id IS NULL OR dispatch_user_id=user_id);

UPDATE hosted_whatsapp_inbound SET dispatch_user_id=(SELECT user_id FROM hosted_whatsapp_outbox WHERE turn_id=hosted_whatsapp_inbound.turn_id),dispatch_offered_at_ms=(SELECT offered_at_ms FROM hosted_whatsapp_outbox WHERE turn_id=hosted_whatsapp_inbound.turn_id),dispatch_created_at_ms=(SELECT created_at_ms FROM hosted_whatsapp_outbox WHERE turn_id=hosted_whatsapp_inbound.turn_id);

ALTER TABLE statement_submissions ADD COLUMN work_user_id TEXT REFERENCES users(id);

ALTER TABLE statement_submissions ADD COLUMN work_revision INTEGER;

ALTER TABLE statement_submissions ADD COLUMN work_published_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN work_last_attempt_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN work_last_reconciled_at_ms INTEGER CHECK((work_revision IS NULL AND work_user_id IS NULL AND work_revision IS NULL AND work_published_at_ms IS NULL AND work_last_attempt_at_ms IS NULL AND work_last_reconciled_at_ms IS NULL) OR (work_revision IS NOT NULL AND work_user_id IS NOT NULL AND work_revision IS NOT NULL AND (work_revision = 1) AND work_published_at_ms IS NOT NULL AND (work_published_at_ms >= 0) AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms >= 0) AND (work_last_reconciled_at_ms IS NULL OR work_last_reconciled_at_ms >= 0))) CHECK(work_user_id IS NULL OR work_user_id=user_id);

UPDATE statement_submissions SET work_user_id=(SELECT user_id FROM statement_ingestion_outbox WHERE submission_id=statement_submissions.id),work_revision=(SELECT revision FROM statement_ingestion_outbox WHERE submission_id=statement_submissions.id),work_published_at_ms=(SELECT published_at_ms FROM statement_ingestion_outbox WHERE submission_id=statement_submissions.id),work_last_attempt_at_ms=(SELECT last_attempt_at_ms FROM statement_ingestion_outbox WHERE submission_id=statement_submissions.id),work_last_reconciled_at_ms=(SELECT last_reconciled_at_ms FROM statement_ingestion_outbox WHERE submission_id=statement_submissions.id);

ALTER TABLE forwarded_email_receipts ADD COLUMN dispatch_user_id TEXT REFERENCES users(id);

ALTER TABLE forwarded_email_receipts ADD COLUMN dispatch_sent_at_ms INTEGER CHECK((dispatch_user_id IS NULL AND dispatch_user_id IS NULL AND dispatch_sent_at_ms IS NULL) OR (dispatch_user_id IS NOT NULL AND dispatch_user_id IS NOT NULL)) CHECK(dispatch_user_id IS NULL OR dispatch_user_id=user_id);

UPDATE forwarded_email_receipts SET dispatch_user_id=(SELECT user_id FROM forwarded_email_outbox WHERE receipt_id=forwarded_email_receipts.id),dispatch_sent_at_ms=(SELECT sent_at_ms FROM forwarded_email_outbox WHERE receipt_id=forwarded_email_receipts.id);

ALTER TABLE recurring_digest_instructions ADD COLUMN source_checkpoint TEXT;

ALTER TABLE recurring_digest_instructions ADD COLUMN source_cursor TEXT;

ALTER TABLE recurring_digest_instructions ADD COLUMN source_cutoff_at_ms INTEGER;

ALTER TABLE recurring_digest_instructions ADD COLUMN source_complete INTEGER CHECK((source_checkpoint IS NULL AND source_checkpoint IS NULL AND source_cursor IS NULL AND source_cutoff_at_ms IS NULL AND source_complete IS NULL) OR (source_checkpoint IS NOT NULL AND source_checkpoint IS NOT NULL AND source_cutoff_at_ms IS NOT NULL AND source_complete IS NOT NULL AND (source_complete IN (0,1))));

UPDATE recurring_digest_instructions SET source_checkpoint=(SELECT checkpoint FROM recurring_digest_scans WHERE user_id=recurring_digest_instructions.user_id),source_cursor=(SELECT cursor FROM recurring_digest_scans WHERE user_id=recurring_digest_instructions.user_id),source_cutoff_at_ms=(SELECT cutoff_at_ms FROM recurring_digest_scans WHERE user_id=recurring_digest_instructions.user_id),source_complete=(SELECT complete FROM recurring_digest_scans WHERE user_id=recurring_digest_instructions.user_id);

DROP TABLE hosted_delivery_proposals;

DROP TABLE hosted_turn_retention;

DROP TABLE hosted_compacted_conversations;

DROP TABLE hosted_whatsapp_outbox;

DROP TABLE statement_ingestion_outbox;

DROP TABLE forwarded_email_outbox;

DROP TABLE recurring_digest_scans;

CREATE INDEX hosted_turn_retention_due
  ON hosted_turns(retention_terminal_at_ms, retention_user_id, id) WHERE retention_terminal_at_ms IS NOT NULL;

CREATE INDEX hosted_turn_retention_user
  ON hosted_turns(retention_user_id, retention_terminal_at_ms, id) WHERE retention_terminal_at_ms IS NOT NULL;

CREATE INDEX hosted_compacted_retention_due ON hosted_agent_sessions(compacted_at_ms, user_id) WHERE compacted_revision IS NOT NULL;

CREATE INDEX hosted_compacted_retention_user ON hosted_agent_sessions(user_id, compacted_at_ms) WHERE compacted_revision IS NOT NULL;

CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_whatsapp_inbound(dispatch_offered_at_ms, dispatch_created_at_ms) WHERE dispatch_created_at_ms IS NOT NULL;

CREATE INDEX statement_ingestion_outbox_attempt
  ON statement_submissions(work_last_attempt_at_ms, work_published_at_ms, id) WHERE work_revision IS NOT NULL;

CREATE INDEX statement_ingestion_outbox_reconciliation
  ON statement_submissions(work_last_reconciled_at_ms, work_published_at_ms, id) WHERE work_revision IS NOT NULL;

CREATE INDEX forwarded_email_outbox_pending ON forwarded_email_receipts(dispatch_sent_at_ms) WHERE dispatch_user_id IS NOT NULL;

CREATE TRIGGER hosted_turns_begin_pending BEFORE INSERT ON hosted_turns
WHEN NEW.status <> 'pending'
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_must_begin_pending');
END;

CREATE TRIGGER hosted_turns_terminal_once BEFORE UPDATE OF id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason ON hosted_turns
WHEN OLD.status <> 'pending' OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
  OR NEW.hosted_session_id <> OLD.hosted_session_id OR NEW.started_at_ms <> OLD.started_at_ms
  OR NEW.status = 'pending'
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_terminal_once');
END;

CREATE TRIGGER hosted_turn_daily_budget BEFORE INSERT ON hosted_turns
WHEN (SELECT COUNT(*) FROM hosted_turns WHERE user_id = NEW.user_id
      AND started_at_ms >= (NEW.started_at_ms / 86400000) * 86400000
      AND started_at_ms < ((NEW.started_at_ms / 86400000) + 1) * 86400000) >= 50
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_daily_budget');
END;

CREATE TRIGGER hosted_delivery_proposals_no_update BEFORE UPDATE OF proposal_user_id,proposal_receipt_digest,proposed_at_ms,proposal_text ON hosted_turns
WHEN OLD.proposed_at_ms IS NOT NULL AND (NEW.proposal_user_id IS NOT OLD.proposal_user_id OR NEW.proposal_receipt_digest IS NOT OLD.proposal_receipt_digest OR NEW.proposed_at_ms IS NOT OLD.proposed_at_ms OR NEW.proposal_text IS NOT OLD.proposal_text) AND NEW.proposed_at_ms IS NOT NULL AND (NEW.id <> OLD.id OR NEW.proposal_user_id <> OLD.proposal_user_id OR NEW.proposal_text <> OLD.proposal_text
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.id
    AND user_id = OLD.proposal_user_id AND status = 'pending'))
BEGIN
 SELECT RAISE(ABORT, 'hosted_delivery_immutable');
END;

CREATE TRIGGER hosted_whatsapp_inbound_no_update BEFORE UPDATE OF turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms,reply_to_message_id,sandbox_phone ON hosted_whatsapp_inbound
BEGIN
 SELECT RAISE(ABORT, 'hosted_whatsapp_inbound_immutable');
END;

CREATE TRIGGER hosted_turn_retention_terminal AFTER UPDATE ON hosted_turns
WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
BEGIN
 UPDATE hosted_turns SET retention_user_id=incoming.user_id,retention_terminal_at_ms=incoming.terminal_at_ms FROM (SELECT NEW.id AS turn_id,NEW.user_id AS user_id,NEW.terminal_at_ms AS terminal_at_ms) AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.retention_terminal_at_ms IS NULL;
END;

CREATE TRIGGER hosted_retention_transcript_append AFTER INSERT ON transcript_entries
BEGIN
 UPDATE hosted_turns SET retention_user_id=incoming.user_id,retention_terminal_at_ms=incoming.terminal_at_ms FROM (SELECT id AS turn_id,user_id AS user_id,terminal_at_ms AS terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending') AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.retention_terminal_at_ms IS NULL;
END;

CREATE TRIGGER hosted_retention_mutation_append AFTER INSERT ON hosted_mutation_commits
BEGIN
 UPDATE hosted_turns SET retention_user_id=incoming.user_id,retention_terminal_at_ms=incoming.terminal_at_ms FROM (SELECT id AS turn_id,user_id AS user_id,terminal_at_ms AS terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending') AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.retention_terminal_at_ms IS NULL;
END;

CREATE TRIGGER hosted_retention_channel_append AFTER INSERT ON hosted_whatsapp_inbound
BEGIN
 UPDATE hosted_turns SET retention_user_id=incoming.user_id,retention_terminal_at_ms=incoming.terminal_at_ms FROM (SELECT id AS turn_id,user_id AS user_id,terminal_at_ms AS terminal_at_ms FROM hosted_turns
  WHERE id = NEW.turn_id AND user_id = NEW.user_id AND status <> 'pending') AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.retention_terminal_at_ms IS NULL;
END;

CREATE TRIGGER statement_progress_order BEFORE INSERT ON statement_record_outcomes
WHEN NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=NEW.submission_id AND s.user_id=NEW.user_id
  AND s.processed_rows+1=NEW.record_number)
BEGIN
 SELECT RAISE(ABORT,'statement_progress_order');
END;

CREATE TRIGGER statement_progress AFTER INSERT ON statement_record_outcomes
BEGIN
 UPDATE statement_submissions SET processed_rows=processed_rows+1,
  processed_accepted_rows=processed_accepted_rows+(NEW.outcome='accepted'),
  processed_review_rows=processed_review_rows+(NEW.outcome='needs-review')
  WHERE id=NEW.submission_id AND user_id=NEW.user_id;
END;

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

CREATE TRIGGER erasure_fence_hosted_agent_sessions_insert BEFORE INSERT ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_agent_sessions_update BEFORE UPDATE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_agent_sessions_delete BEFORE DELETE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_agent_sessions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_turns_insert BEFORE INSERT ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_turns_update BEFORE UPDATE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_turns_delete BEFORE DELETE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_inbound_insert BEFORE INSERT ON hosted_whatsapp_inbound
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_inbound_update BEFORE UPDATE ON hosted_whatsapp_inbound
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_inbound_delete BEFORE DELETE ON hosted_whatsapp_inbound
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

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

CREATE TRIGGER erasure_preserve_hosted_turns_delete BEFORE DELETE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_turns','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'started_at_ms',OLD."started_at_ms",'terminal_at_ms',OLD."terminal_at_ms",'status',OLD."status",'failure_reason',OLD."failure_reason",'proposal_user_id',OLD.proposal_user_id,'proposed_at_ms',OLD.proposed_at_ms,'proposal_text',OLD.proposal_text,'retention_user_id',OLD.retention_user_id,'retention_terminal_at_ms',OLD.retention_terminal_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_whatsapp_inbound_delete BEFORE DELETE ON hosted_whatsapp_inbound
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'message_id',OLD."message_id",'business_phone_number_id',OLD."business_phone_number_id",'occurred_at_ms',OLD."occurred_at_ms",'received_at_ms',OLD."received_at_ms",'reply_to_message_id',OLD."reply_to_message_id",'sandbox_phone',OLD."sandbox_phone",'dispatch_user_id',OLD.dispatch_user_id,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

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
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND retention_user_id = OLD.user_id;
END;

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
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND retention_user_id = OLD.user_id;
END;

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
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND retention_user_id = OLD.user_id;
END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_insert BEFORE INSERT ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_update BEFORE UPDATE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_delete BEFORE DELETE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_recurring_digest_instructions_delete BEFORE DELETE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_instructions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'version',OLD."version",'enabled',OLD."enabled",'grant_id',OLD."grant_id",'context_json',OLD."context_json",'acceptance_from_ms',OLD."acceptance_from_ms",'accepted_at_ms',OLD."accepted_at_ms",'last_source_identity',OLD."last_source_identity",'next_closed_at_ms',OLD."next_closed_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms",'source_checkpoint',OLD.source_checkpoint,'source_cursor',OLD.source_cursor,'source_cutoff_at_ms',OLD.source_cutoff_at_ms,'source_complete',OLD.source_complete)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

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

CREATE TRIGGER statement_partial_backfill_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
BEGIN
 UPDATE statement_backfill_entitlements
    SET submission_id = CASE WHEN consumed_at_ms IS NULL THEN NULL ELSE submission_id END
    WHERE user_id = NEW.user_id AND submission_id = NEW.id;
END;

CREATE TRIGGER statement_origin_no_resumption BEFORE UPDATE OF hosted_session_id,hosted_turn_id,hosted_expires_at_ms,hosted_abandoned_at_ms ON statement_submissions
WHEN OLD.hosted_session_id IS NOT NULL AND (OLD.hosted_abandoned_at_ms IS NOT NULL OR NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id OR NEW.hosted_session_id != OLD.hosted_session_id OR NEW.hosted_turn_id != OLD.hosted_turn_id
)
BEGIN
 SELECT RAISE(ABORT, 'statement_origin_terminal');
END;

CREATE TRIGGER statement_document_published AFTER UPDATE OF hosted_session_id ON statement_submissions
WHEN OLD.hosted_session_id IS NULL AND NEW.hosted_session_id IS NOT NULL
BEGIN
 DELETE FROM statement_whatsapp_documents WHERE turn_id=NEW.hosted_turn_id AND user_id=NEW.user_id;
END;

CREATE TRIGGER statement_terminal_material AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing')
BEGIN
 UPDATE statement_staging_objects SET status='deleting',published_submission_id=NULL
  WHERE id=NEW.staging_id AND user_id=NEW.user_id AND status='published'
    AND object_deleted_at_ms IS NULL;
END;

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

CREATE TRIGGER statement_materialization_part_guard BEFORE INSERT ON statement_materialization_parts
WHEN NOT EXISTS (SELECT 1 FROM statement_submissions m WHERE m.id=NEW.submission_id
  AND m.material_state='building' AND m.status IN ('queued','processing'))
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_part_guard');
END;

CREATE TRIGGER statement_progress_initial BEFORE INSERT ON statement_submissions
WHEN NEW.processed_rows<>0 OR NEW.processed_accepted_rows<>0 OR NEW.processed_review_rows<>0
BEGIN
 SELECT RAISE(ABORT,'statement_progress_initial');
END;

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

CREATE TRIGGER statement_partial_accounting_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status='failed' AND OLD.status IN ('queued','processing')
  AND NEW.input_rows IS NULL AND NEW.processed_rows>0
BEGIN
 UPDATE statement_submissions SET input_rows=processed_rows,
    accepted_rows=processed_accepted_rows, needs_review_rows=processed_review_rows
    WHERE id=NEW.id AND user_id=NEW.user_id;
END;

CREATE TRIGGER erasure_fence_statement_submissions_insert BEFORE INSERT ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_statement_submissions_update BEFORE UPDATE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_insert BEFORE INSERT ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_update BEFORE UPDATE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_delete BEFORE DELETE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

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

CREATE TRIGGER statement_clarification_transition BEFORE UPDATE OF clarification_state ON statement_submissions
WHEN OLD.clarification_state IS NOT NULL AND NOT ((NEW.clarification_state=OLD.clarification_state AND NEW.clarification_ended_at_ms IS OLD.clarification_ended_at_ms)
 OR (OLD.clarification_state='awaiting' AND NEW.clarification_state IN ('completed','abandoned') AND NEW.clarification_ended_at_ms IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT,'statement_clarification_terminal');
END;

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
 UPDATE statement_backfill_entitlements SET submission_id=NULL
 WHERE user_id=NEW.user_id AND submission_id=NEW.id AND consumed_at_ms IS NULL;
END;

CREATE TRIGGER statement_clarification_release AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='completed'
BEGIN
 UPDATE statement_backfill_entitlements SET submission_id=NULL
 WHERE user_id=NEW.user_id AND submission_id=NEW.id AND consumed_at_ms IS NULL;
END;

CREATE TRIGGER erasure_preserve_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows",'material_source_sha256',OLD.material_source_sha256,'material_parts_sha256',OLD.material_parts_sha256,'material_parser_revision',OLD.material_parser_revision,'material_source_format',OLD.material_source_format,'material_representation_revision',OLD.material_representation_revision,'material_service_market',OLD.material_service_market,'material_locale',OLD.material_locale,'material_time_zone',OLD.material_time_zone,'material_expires_at_ms',OLD.material_expires_at_ms,'material_headers_json',OLD.material_headers_json,'material_row_count',OLD.material_row_count,'material_part_count',OLD.material_part_count,'material_byte_length',OLD.material_byte_length,'material_state',OLD.material_state,'hosted_session_id',OLD.hosted_session_id,'hosted_turn_id',OLD.hosted_turn_id,'hosted_expires_at_ms',OLD.hosted_expires_at_ms,'hosted_abandoned_at_ms',OLD.hosted_abandoned_at_ms,'clarification_state',OLD.clarification_state,'clarification_expires_at_ms',OLD.clarification_expires_at_ms,'clarification_ended_at_ms',OLD.clarification_ended_at_ms,'work_user_id',OLD.work_user_id,'work_revision',OLD.work_revision,'work_published_at_ms',OLD.work_published_at_ms,'work_last_attempt_at_ms',OLD.work_last_attempt_at_ms,'work_last_reconciled_at_ms',OLD.work_last_reconciled_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER statement_materialization_terminal AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed')
BEGIN
 DELETE FROM statement_materialization_parts WHERE submission_id=NEW.id;
 UPDATE statement_submissions SET material_source_sha256=NULL,material_parts_sha256=NULL,material_parser_revision=NULL,material_source_format=NULL,material_representation_revision=NULL,material_service_market=NULL,material_locale=NULL,material_time_zone=NULL,material_expires_at_ms=NULL,material_headers_json=NULL,material_row_count=NULL,material_part_count=NULL,material_byte_length=NULL,material_state=NULL WHERE id=NEW.id AND material_state IS NOT NULL;
END;

CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing') AND NEW.needs_review_rows>0
BEGIN
 UPDATE statement_submissions SET clarification_state='awaiting',clarification_expires_at_ms=(SELECT min(evidence_expires_at_ms) FROM statement_needs_review WHERE submission_id=NEW.id),clarification_ended_at_ms=NULL WHERE id=NEW.id;
 UPDATE statement_submissions SET clarification_state='abandoned',clarification_ended_at_ms=NEW.completed_at_ms WHERE id=NEW.id AND clarification_expires_at_ms<=NEW.completed_at_ms;
END;

CREATE TRIGGER statement_companions_valid_insert BEFORE INSERT ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN
 SELECT RAISE(ABORT,'statement_companions_invalid');
END;

CREATE TRIGGER statement_companions_valid_update BEFORE UPDATE ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN
 SELECT RAISE(ABORT,'statement_companions_invalid');
END;

CREATE TRIGGER statement_materialization_clear BEFORE UPDATE OF material_state ON statement_submissions WHEN OLD.material_state IS NOT NULL AND NEW.material_state IS NULL AND NEW.status NOT IN ('completed','failed') BEGIN
 SELECT RAISE(ABORT,'statement_materialization_identity');
END;

CREATE TRIGGER statement_materialization_initial BEFORE INSERT ON statement_submissions
WHEN NEW.material_state IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'statement_materialization_owner');
END;

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

CREATE TRIGGER erasure_fence_forwarded_email_receipts_insert BEFORE INSERT ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER forwarded_email_deferred_capacity_insert BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN
 SELECT RAISE(ABORT,'forwarded_email_deferred_capacity');
END;

CREATE TRIGGER forwarded_email_deferred_capacity_update BEFORE UPDATE OF deferred_checked_at_ms ON forwarded_email_receipts
WHEN OLD.deferred_checked_at_ms IS NULL AND NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN
 SELECT RAISE(ABORT,'forwarded_email_deferred_capacity');
END;

CREATE TRIGGER forwarded_email_deferred_expiry AFTER UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state='expired' AND NEW.deferred_checked_at_ms IS NOT NULL
BEGIN
 UPDATE forwarded_email_receipts SET deferred_checked_at_ms=NULL WHERE id=NEW.id AND user_id=NEW.user_id;
END;

CREATE TRIGGER erasure_fence_forwarded_email_receipts_update BEFORE UPDATE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

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

CREATE TRIGGER forwarded_email_outcome_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.outcome IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.outcome IS NOT OLD.outcome OR NEW.outcome_transaction_id IS NOT OLD.outcome_transaction_id OR NEW.outcome_review_id IS NOT OLD.outcome_review_id OR NEW.outcome_completed_at_ms IS NOT OLD.outcome_completed_at_ms) BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;

CREATE TRIGGER forwarded_email_review_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.review_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.review_id IS NOT OLD.review_id OR NEW.review_reason IS NOT OLD.review_reason OR NEW.review_created_at_ms IS NOT OLD.review_created_at_ms OR NEW.review_evidence_expires_at_ms IS NOT OLD.review_evidence_expires_at_ms) BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;

CREATE TRIGGER forwarded_email_companions_valid_insert BEFORE INSERT ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;

CREATE TRIGGER forwarded_email_companions_valid_update BEFORE UPDATE ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;

CREATE TRIGGER forwarded_email_completion_initial BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.outcome IS NOT NULL OR NEW.review_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'email_record_invalid');
END;

CREATE TRIGGER forwarded_email_completed_no_delete BEFORE DELETE ON forwarded_email_receipts
WHEN (OLD.outcome IS NOT NULL OR OLD.review_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='forwarded_email_receipts' AND p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing')
BEGIN
 SELECT RAISE(ABORT,'email_record_append_only');
END;

CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_consent_required');
END;

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;

CREATE TRIGGER forwarded_email_outcome_consent BEFORE UPDATE OF outcome ON forwarded_email_receipts
WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND ((NEW.outcome <> 'needs-review' OR NOT (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.outcome_completed_at_ms)))
  OR ((NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.outcome_completed_at_ms OR (NEW.outcome = 'needs-review'
        AND (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason IN ('processing-interrupted','consent-revoked')))))
)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_authority');
END;

CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE OF status,terminal_at_ms,failure_reason ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM (SELECT rowid,id AS turn_id,proposal_user_id AS user_id,proposal_receipt_digest AS receipt_digest,proposed_at_ms,proposal_text AS text FROM hosted_turns WHERE proposed_at_ms IS NOT NULL) AS hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required');
END;

CREATE VIEW ingestion_review_originals AS
SELECT r.id, r.user_id, 'statement' AS source, r.reason, r.created_at_ms,
  r.evidence_expires_at_ms AS expires_at_ms, r.service_market, r.locale, r.time_zone, r.review_suggestions_json AS suggestions_json,
  'pending' AS status, NULL AS transaction_id
FROM statement_needs_review r
UNION ALL
SELECT s.review_id,s.user_id,'email',s.review_reason,s.review_created_at_ms,s.review_evidence_expires_at_ms,'CO','es-CO',s.time_zone,NULL,'pending',NULL FROM forwarded_email_receipts s WHERE s.review_id IS NOT NULL
UNION ALL
SELECT s.id, s.user_id, 'media', s.review_reason, s.review_created_at_ms, s.expires_at_ms,
  s.service_market, s.locale, s.time_zone, NULL, 'pending', NULL
FROM media_submissions s WHERE s.review_reason IS NOT NULL;

CREATE VIEW ingestion_review_sources AS
SELECT s.id,s.user_id,s.source,s.reason,s.created_at_ms,s.expires_at_ms,s.service_market,s.locale,s.time_zone,
  CASE WHEN d.status='abandoned' THEN 'expired' ELSE coalesce(d.status,s.status) END AS status,coalesce(d.transaction_id,s.transaction_id) AS transaction_id,
  coalesce(d.revision,0) AS revision,d.draft_json,s.suggestions_json
FROM ingestion_review_originals s LEFT JOIN ingestion_review_state d ON d.id=s.id AND d.user_id=s.user_id;

CREATE TRIGGER hosted_turns_companions_initial BEFORE INSERT ON hosted_turns WHEN NEW.proposal_user_id IS NOT NULL OR NEW.proposal_receipt_digest IS NOT NULL OR NEW.proposed_at_ms IS NOT NULL OR NEW.proposal_text IS NOT NULL OR NEW.retention_user_id IS NOT NULL OR NEW.retention_terminal_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'hosted_turns_companions_initial'); END;

CREATE TRIGGER hosted_agent_sessions_companions_initial BEFORE INSERT ON hosted_agent_sessions WHEN NEW.compacted_text IS NOT NULL OR NEW.compacted_through_sequence IS NOT NULL OR NEW.compacted_revision IS NOT NULL OR NEW.compacted_nonce IS NOT NULL OR NEW.compacted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'hosted_agent_sessions_companions_initial'); END;

CREATE TRIGGER hosted_whatsapp_inbound_companions_initial BEFORE INSERT ON hosted_whatsapp_inbound WHEN NEW.dispatch_user_id IS NOT NULL OR NEW.dispatch_offered_at_ms IS NOT NULL OR NEW.dispatch_created_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'hosted_whatsapp_inbound_companions_initial'); END;

CREATE TRIGGER statement_submissions_companions_initial BEFORE INSERT ON statement_submissions WHEN NEW.work_user_id IS NOT NULL OR NEW.work_revision IS NOT NULL OR NEW.work_published_at_ms IS NOT NULL OR NEW.work_last_attempt_at_ms IS NOT NULL OR NEW.work_last_reconciled_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'statement_submissions_companions_initial'); END;

CREATE TRIGGER forwarded_email_receipts_companions_initial BEFORE INSERT ON forwarded_email_receipts WHEN NEW.dispatch_user_id IS NOT NULL OR NEW.dispatch_sent_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'forwarded_email_receipts_companions_initial'); END;

CREATE TRIGGER recurring_digest_instructions_companions_initial BEFORE INSERT ON recurring_digest_instructions WHEN NEW.source_checkpoint IS NOT NULL OR NEW.source_cursor IS NOT NULL OR NEW.source_cutoff_at_ms IS NOT NULL OR NEW.source_complete IS NOT NULL BEGIN SELECT RAISE(ABORT,'recurring_digest_instructions_companions_initial'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_parent_work',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_parent_work';

PRAGMA defer_foreign_keys=OFF;
