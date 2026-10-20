PRAGMA defer_foreign_keys=ON;

DROP TRIGGER statement_submission_state_insert;

DROP TRIGGER statement_submission_state_update;

DROP TRIGGER statement_partial_backfill_on_failure;

DROP TRIGGER statement_origin_no_resumption;

DROP TRIGGER statement_document_published;

DROP TRIGGER statement_terminal_material;

DROP TRIGGER statement_materialization_owner;

DROP TRIGGER statement_materialization_identity;

DROP TRIGGER statement_materialization_part_guard;

DROP TRIGGER statement_materialization_part_immutable;

DROP TRIGGER statement_materialization_terminal;

DROP TRIGGER statement_progress_initial;

DROP TRIGGER statement_progress_conservation;

DROP TRIGGER statement_progress_terminal;

DROP TRIGGER statement_partial_accounting_on_failure;

DROP TRIGGER erasure_fence_statement_clarifications_insert;

DROP TRIGGER erasure_fence_statement_clarifications_update;

DROP TRIGGER erasure_fence_statement_clarifications_delete;

DROP TRIGGER erasure_fence_statement_hosted_origins_insert;

DROP TRIGGER erasure_fence_statement_hosted_origins_update;

DROP TRIGGER erasure_fence_statement_hosted_origins_delete;

DROP TRIGGER erasure_fence_statement_materializations_insert;

DROP TRIGGER erasure_fence_statement_materializations_update;

DROP TRIGGER erasure_fence_statement_materializations_delete;

DROP TRIGGER erasure_fence_statement_submissions_insert;

DROP TRIGGER erasure_fence_statement_submissions_update;

DROP TRIGGER erasure_fence_statement_submissions_delete;

DROP TRIGGER erasure_fence_statement_materialization_parts_insert;

DROP TRIGGER erasure_fence_statement_materialization_parts_update;

DROP TRIGGER erasure_fence_statement_materialization_parts_delete;

DROP TRIGGER erasure_preserve_statement_clarifications_delete;

DROP TRIGGER erasure_preserve_statement_hosted_origins_delete;

DROP TRIGGER erasure_preserve_statement_materialization_parts_delete;

DROP TRIGGER erasure_preserve_statement_materializations_delete;

DROP TRIGGER statement_extraction_clarification;

DROP TRIGGER statement_clarification_transition;

DROP TRIGGER statement_clarification_abandon;

DROP TRIGGER statement_clarification_release;

DROP TRIGGER erasure_preserve_statement_submissions_delete;

ALTER TABLE statement_submissions ADD COLUMN material_source_sha256 TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_parts_sha256 TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_parser_revision TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_source_format TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_representation_revision TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_service_market TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_locale TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_time_zone TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_expires_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN material_headers_json TEXT;

ALTER TABLE statement_submissions ADD COLUMN material_row_count INTEGER;

ALTER TABLE statement_submissions ADD COLUMN material_part_count INTEGER;

ALTER TABLE statement_submissions ADD COLUMN material_byte_length INTEGER;

ALTER TABLE statement_submissions ADD COLUMN material_state TEXT;

UPDATE statement_submissions SET material_source_sha256=(SELECT source_sha256 FROM statement_materializations WHERE submission_id=statement_submissions.id),material_parts_sha256=(SELECT parts_sha256 FROM statement_materializations WHERE submission_id=statement_submissions.id),material_parser_revision=(SELECT parser_revision FROM statement_materializations WHERE submission_id=statement_submissions.id),material_source_format=(SELECT source_format FROM statement_materializations WHERE submission_id=statement_submissions.id),material_representation_revision=(SELECT representation_revision FROM statement_materializations WHERE submission_id=statement_submissions.id),material_service_market=(SELECT service_market FROM statement_materializations WHERE submission_id=statement_submissions.id),material_locale=(SELECT locale FROM statement_materializations WHERE submission_id=statement_submissions.id),material_time_zone=(SELECT time_zone FROM statement_materializations WHERE submission_id=statement_submissions.id),material_expires_at_ms=(SELECT expires_at_ms FROM statement_materializations WHERE submission_id=statement_submissions.id),material_headers_json=(SELECT headers_json FROM statement_materializations WHERE submission_id=statement_submissions.id),material_row_count=(SELECT row_count FROM statement_materializations WHERE submission_id=statement_submissions.id),material_part_count=(SELECT part_count FROM statement_materializations WHERE submission_id=statement_submissions.id),material_byte_length=(SELECT byte_length FROM statement_materializations WHERE submission_id=statement_submissions.id),material_state=(SELECT state FROM statement_materializations WHERE submission_id=statement_submissions.id);

ALTER TABLE statement_submissions ADD COLUMN hosted_session_id TEXT;

ALTER TABLE statement_submissions ADD COLUMN hosted_turn_id TEXT;

ALTER TABLE statement_submissions ADD COLUMN hosted_expires_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN hosted_abandoned_at_ms INTEGER;

UPDATE statement_submissions SET hosted_session_id=(SELECT session_id FROM statement_hosted_origins WHERE submission_id=statement_submissions.id),hosted_turn_id=(SELECT turn_id FROM statement_hosted_origins WHERE submission_id=statement_submissions.id),hosted_expires_at_ms=(SELECT expires_at_ms FROM statement_hosted_origins WHERE submission_id=statement_submissions.id),hosted_abandoned_at_ms=(SELECT abandoned_at_ms FROM statement_hosted_origins WHERE submission_id=statement_submissions.id);

ALTER TABLE statement_submissions ADD COLUMN clarification_state TEXT;

ALTER TABLE statement_submissions ADD COLUMN clarification_expires_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN clarification_ended_at_ms INTEGER;

UPDATE statement_submissions SET clarification_state=(SELECT state FROM statement_clarifications WHERE submission_id=statement_submissions.id),clarification_expires_at_ms=(SELECT expires_at_ms FROM statement_clarifications WHERE submission_id=statement_submissions.id),clarification_ended_at_ms=(SELECT ended_at_ms FROM statement_clarifications WHERE submission_id=statement_submissions.id);

CREATE TABLE statement_materialization_parts_consolidated (
  submission_id TEXT NOT NULL REFERENCES statement_submissions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 624),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 1023),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(submission_id,chunk_index,part_index)
) STRICT;

INSERT INTO statement_materialization_parts_consolidated SELECT * FROM statement_materialization_parts;

DROP TABLE statement_materialization_parts;

ALTER TABLE statement_materialization_parts_consolidated RENAME TO statement_materialization_parts;

DROP TABLE statement_materializations;

DROP TABLE statement_hosted_origins;

DROP TABLE statement_clarifications;

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
BEGIN SELECT RAISE(ABORT, 'statement_submission_state'); END;

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
BEGIN SELECT RAISE(ABORT, 'statement_submission_state'); END;

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
BEGIN SELECT RAISE(ABORT, 'statement_origin_terminal'); END;

CREATE TRIGGER statement_document_published AFTER UPDATE OF hosted_session_id ON statement_submissions
WHEN OLD.hosted_session_id IS NULL AND NEW.hosted_session_id IS NOT NULL
BEGIN DELETE FROM statement_whatsapp_documents WHERE turn_id=NEW.hosted_turn_id AND user_id=NEW.user_id; END;

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
BEGIN SELECT RAISE(ABORT,'statement_materialization_owner'); END;

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
BEGIN SELECT RAISE(ABORT,'statement_materialization_identity'); END;

CREATE TRIGGER statement_materialization_part_guard BEFORE INSERT ON statement_materialization_parts
WHEN NOT EXISTS (SELECT 1 FROM statement_submissions m WHERE m.id=NEW.submission_id
  AND m.material_state='building' AND m.status IN ('queued','processing'))
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_guard'); END;

CREATE TRIGGER statement_materialization_part_immutable BEFORE UPDATE ON statement_materialization_parts
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_immutable'); END;

CREATE TRIGGER statement_progress_initial BEFORE INSERT ON statement_submissions
WHEN NEW.processed_rows<>0 OR NEW.processed_accepted_rows<>0 OR NEW.processed_review_rows<>0
BEGIN SELECT RAISE(ABORT,'statement_progress_initial'); END;

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
BEGIN SELECT RAISE(ABORT,'statement_progress_conservation'); END;

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
BEGIN SELECT RAISE(ABORT,'statement_progress_terminal'); END;

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
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_statement_submissions_update BEFORE UPDATE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_insert BEFORE INSERT ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_update BEFORE UPDATE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=NEW.submission_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_statement_materialization_parts_delete BEFORE DELETE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=OLD.submission_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_materialization_parts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

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
BEGIN SELECT RAISE(ABORT,'statement_clarification_terminal'); END;

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
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows",'material_source_sha256',OLD.material_source_sha256,'material_parts_sha256',OLD.material_parts_sha256,'material_parser_revision',OLD.material_parser_revision,'material_source_format',OLD.material_source_format,'material_representation_revision',OLD.material_representation_revision,'material_service_market',OLD.material_service_market,'material_locale',OLD.material_locale,'material_time_zone',OLD.material_time_zone,'material_expires_at_ms',OLD.material_expires_at_ms,'material_headers_json',OLD.material_headers_json,'material_row_count',OLD.material_row_count,'material_part_count',OLD.material_part_count,'material_byte_length',OLD.material_byte_length,'material_state',OLD.material_state,'hosted_session_id',OLD.hosted_session_id,'hosted_turn_id',OLD.hosted_turn_id,'hosted_expires_at_ms',OLD.hosted_expires_at_ms,'hosted_abandoned_at_ms',OLD.hosted_abandoned_at_ms,'clarification_state',OLD.clarification_state,'clarification_expires_at_ms',OLD.clarification_expires_at_ms,'clarification_ended_at_ms',OLD.clarification_ended_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER statement_materialization_terminal AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed')
BEGIN DELETE FROM statement_materialization_parts WHERE submission_id=NEW.id;
 UPDATE statement_submissions SET material_source_sha256=NULL,material_parts_sha256=NULL,material_parser_revision=NULL,material_source_format=NULL,material_representation_revision=NULL,material_service_market=NULL,material_locale=NULL,material_time_zone=NULL,material_expires_at_ms=NULL,material_headers_json=NULL,material_row_count=NULL,material_part_count=NULL,material_byte_length=NULL,material_state=NULL WHERE id=NEW.id AND material_state IS NOT NULL; END;

CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing') AND NEW.needs_review_rows>0
BEGIN
 UPDATE statement_submissions SET clarification_state='awaiting',clarification_expires_at_ms=(SELECT min(evidence_expires_at_ms) FROM statement_needs_review WHERE submission_id=NEW.id),clarification_ended_at_ms=NULL WHERE id=NEW.id;
 UPDATE statement_submissions SET clarification_state='abandoned',clarification_ended_at_ms=NEW.completed_at_ms WHERE id=NEW.id AND clarification_expires_at_ms<=NEW.completed_at_ms;
END;

CREATE TRIGGER statement_companions_valid_insert BEFORE INSERT ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN SELECT RAISE(ABORT,'statement_companions_invalid'); END;

CREATE TRIGGER statement_companions_valid_update BEFORE UPDATE ON statement_submissions WHEN coalesce(((NEW.hosted_session_id IS NULL AND NEW.hosted_turn_id IS NULL AND NEW.hosted_expires_at_ms IS NULL AND NEW.hosted_abandoned_at_ms IS NULL) OR (NEW.hosted_session_id IS NOT NULL AND NEW.hosted_turn_id IS NOT NULL AND NEW.hosted_expires_at_ms IS NOT NULL)) AND ((NEW.clarification_state IS NULL AND NEW.clarification_expires_at_ms IS NULL AND NEW.clarification_ended_at_ms IS NULL) OR (NEW.clarification_state IN ('awaiting','completed','abandoned') AND NEW.clarification_expires_at_ms IS NOT NULL AND ((NEW.clarification_state='awaiting')=(NEW.clarification_ended_at_ms IS NULL)))) AND ((NEW.material_source_sha256 IS NULL AND NEW.material_parts_sha256 IS NULL AND NEW.material_parser_revision IS NULL AND NEW.material_source_format IS NULL AND NEW.material_representation_revision IS NULL AND NEW.material_service_market IS NULL AND NEW.material_locale IS NULL AND NEW.material_time_zone IS NULL AND NEW.material_expires_at_ms IS NULL AND NEW.material_headers_json IS NULL AND NEW.material_row_count IS NULL AND NEW.material_part_count IS NULL AND NEW.material_byte_length IS NULL AND NEW.material_state IS NULL) OR (NEW.material_source_sha256 IS NOT NULL AND NEW.material_parts_sha256 IS NOT NULL AND NEW.material_parser_revision IS NOT NULL AND NEW.material_source_format IS NOT NULL AND NEW.material_representation_revision IS NOT NULL AND NEW.material_service_market IS NOT NULL AND NEW.material_locale IS NOT NULL AND NEW.material_time_zone IS NOT NULL AND NEW.material_expires_at_ms IS NOT NULL AND NEW.material_headers_json IS NOT NULL AND NEW.material_row_count IS NOT NULL AND NEW.material_part_count IS NOT NULL AND NEW.material_byte_length IS NOT NULL AND NEW.material_state IS NOT NULL AND NEW.material_state IN ('building','ready') AND length(NEW.material_source_sha256)=64 AND length(NEW.material_parts_sha256)=64 AND NEW.material_source_format IN ('csv','xlsx') AND json_valid(NEW.material_headers_json) AND length(CAST(NEW.material_headers_json AS BLOB))<=524288 AND NEW.material_row_count BETWEEN 1 AND 20000 AND NEW.material_part_count BETWEEN 1 AND 1024 AND NEW.material_byte_length BETWEEN 1 AND 16777216)),0)=0 BEGIN SELECT RAISE(ABORT,'statement_companions_invalid'); END;

CREATE TRIGGER statement_materialization_clear BEFORE UPDATE OF material_state ON statement_submissions WHEN OLD.material_state IS NOT NULL AND NEW.material_state IS NULL AND NEW.status NOT IN ('completed','failed') BEGIN SELECT RAISE(ABORT,'statement_materialization_identity'); END;

CREATE INDEX statement_clarification_deadline ON statement_submissions(clarification_expires_at_ms) WHERE clarification_state='awaiting';

CREATE INDEX statement_hosted_session ON statement_submissions(user_id,hosted_session_id);

CREATE INDEX statement_hosted_expiry ON statement_submissions(hosted_expires_at_ms) WHERE hosted_session_id IS NOT NULL AND hosted_abandoned_at_ms IS NULL;

CREATE TRIGGER statement_materialization_initial BEFORE INSERT ON statement_submissions
WHEN NEW.material_state IS NOT NULL
BEGIN SELECT RAISE(ABORT,'statement_materialization_owner'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_statement_companions',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_statement_companions';

PRAGMA defer_foreign_keys=OFF;
