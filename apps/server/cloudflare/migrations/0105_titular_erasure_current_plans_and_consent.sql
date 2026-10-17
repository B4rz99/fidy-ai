DROP TRIGGER consent_user_revocations_requires_renewal;
CREATE TRIGGER consent_user_revocations_requires_renewal BEFORE DELETE ON consent_user_revocations
WHEN NOT EXISTS (SELECT 1 FROM processing_consent_renewals n WHERE n.withdrawal_id=OLD.id AND n.user_id=OLD.user_id AND n.grant_record_id=OLD.grant_record_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='consent_user_revocations' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'consent_renewal_required'); END;

CREATE TRIGGER erasure_fence_recurring_plan_documents_insert BEFORE INSERT ON recurring_plan_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_plan_documents_update BEFORE UPDATE ON recurring_plan_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_plan_documents_delete BEFORE DELETE ON recurring_plan_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_recurring_plan_documents_delete BEFORE DELETE ON recurring_plan_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'recurring_plan_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

DROP TRIGGER processing_consent_withdrawal_no_delete;
CREATE TRIGGER processing_consent_withdrawal_no_delete BEFORE DELETE ON processing_consent_withdrawal_records
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='processing_consent_withdrawal_records' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

CREATE TRIGGER erasure_fence_processing_consent_withdrawal_records_insert BEFORE INSERT ON processing_consent_withdrawal_records
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_withdrawal_records'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_processing_consent_withdrawal_records_update BEFORE UPDATE ON processing_consent_withdrawal_records
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_withdrawal_records'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_processing_consent_withdrawal_records_delete BEFORE DELETE ON processing_consent_withdrawal_records
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_withdrawal_records'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_processing_consent_withdrawal_records_delete BEFORE DELETE ON processing_consent_withdrawal_records
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'processing_consent_withdrawal_records','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

DROP TRIGGER processing_consent_renewals_no_delete;
CREATE TRIGGER processing_consent_renewals_no_delete BEFORE DELETE ON processing_consent_renewals
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='processing_consent_renewals' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

CREATE TRIGGER erasure_fence_processing_consent_renewals_insert BEFORE INSERT ON processing_consent_renewals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_renewals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_processing_consent_renewals_update BEFORE UPDATE ON processing_consent_renewals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_renewals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_processing_consent_renewals_delete BEFORE DELETE ON processing_consent_renewals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='processing_consent_renewals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_processing_consent_renewals_delete BEFORE DELETE ON processing_consent_renewals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'processing_consent_renewals','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'withdrawal_id',OLD."withdrawal_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'disclosure_json',OLD."disclosure_json",'accepted_at_ms',OLD."accepted_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
