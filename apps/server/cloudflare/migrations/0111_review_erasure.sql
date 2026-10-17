CREATE TRIGGER erasure_fence_ingestion_review_state_insert BEFORE INSERT ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_review_state_update BEFORE UPDATE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_review_state_delete BEFORE DELETE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

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

DROP TRIGGER erasure_preserve_statement_needs_review_delete;
CREATE TRIGGER erasure_preserve_statement_needs_review_delete BEFORE DELETE ON statement_needs_review
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_needs_review','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'submission_id',OLD."submission_id",'record_number',OLD."record_number",'reason',OLD."reason",'original_evidence',OLD."original_evidence",'known_money',OLD."known_money",'issues',OLD."issues",'status',OLD."status",'evidence_expires_at_ms',OLD."evidence_expires_at_ms",'created_at_ms',OLD."created_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'extractor_revision',OLD."extractor_revision",'review_suggestions_json',OLD."review_suggestions_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

DROP TRIGGER erasure_preserve_source_attestations_delete;
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
