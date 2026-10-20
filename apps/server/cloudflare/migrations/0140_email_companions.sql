PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS forwarded_email_outcome_no_update;

DROP TRIGGER IF EXISTS forwarded_email_review_no_update;

DROP TRIGGER IF EXISTS forwarded_email_capacity;

DROP TRIGGER IF EXISTS forwarded_email_outcome_no_delete;

DROP TRIGGER IF EXISTS forwarded_email_review_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_needs_review_insert;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_needs_review_update;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_needs_review_delete;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outcomes_insert;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outcomes_update;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_outcomes_delete;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_insert;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_delete;

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_needs_review_delete;

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_outcomes_delete;

DROP TRIGGER IF EXISTS forwarded_email_deferred_capacity_insert;

DROP TRIGGER IF EXISTS forwarded_email_deferred_capacity_update;

DROP TRIGGER IF EXISTS forwarded_email_deferred_expiry;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_update;

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_receipts_delete;

DROP TRIGGER IF EXISTS forwarded_email_authority;

DROP TRIGGER IF EXISTS forwarded_email_publication_authority;

DROP TRIGGER IF EXISTS forwarded_email_outcome_consent;

DROP VIEW IF EXISTS ingestion_review_originals;

ALTER TABLE forwarded_email_receipts ADD COLUMN outcome TEXT;

ALTER TABLE forwarded_email_receipts ADD COLUMN outcome_transaction_id TEXT REFERENCES transactions(id);

ALTER TABLE forwarded_email_receipts ADD COLUMN outcome_review_id TEXT;

ALTER TABLE forwarded_email_receipts ADD COLUMN outcome_completed_at_ms INTEGER;

UPDATE forwarded_email_receipts SET outcome=(SELECT outcome FROM forwarded_email_outcomes WHERE receipt_id=forwarded_email_receipts.id),outcome_transaction_id=(SELECT transaction_id FROM forwarded_email_outcomes WHERE receipt_id=forwarded_email_receipts.id),outcome_review_id=(SELECT review_id FROM forwarded_email_outcomes WHERE receipt_id=forwarded_email_receipts.id),outcome_completed_at_ms=(SELECT completed_at_ms FROM forwarded_email_outcomes WHERE receipt_id=forwarded_email_receipts.id);

ALTER TABLE forwarded_email_receipts ADD COLUMN review_id TEXT;

ALTER TABLE forwarded_email_receipts ADD COLUMN review_reason TEXT;

ALTER TABLE forwarded_email_receipts ADD COLUMN review_created_at_ms INTEGER;

ALTER TABLE forwarded_email_receipts ADD COLUMN review_evidence_expires_at_ms INTEGER;

UPDATE forwarded_email_receipts SET review_id=(SELECT id FROM forwarded_email_needs_review WHERE receipt_id=forwarded_email_receipts.id),review_reason=(SELECT reason FROM forwarded_email_needs_review WHERE receipt_id=forwarded_email_receipts.id),review_created_at_ms=(SELECT created_at_ms FROM forwarded_email_needs_review WHERE receipt_id=forwarded_email_receipts.id),review_evidence_expires_at_ms=(SELECT evidence_expires_at_ms FROM forwarded_email_needs_review WHERE receipt_id=forwarded_email_receipts.id);

DROP TABLE forwarded_email_outcomes;

DROP TABLE forwarded_email_needs_review;

CREATE TRIGGER forwarded_email_capacity BEFORE INSERT ON forwarded_email_receipts
WHEN (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.expires_at_ms > NEW.received_at_ms AND r.outcome IS NULL) >= 1000
  OR (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.user_id = NEW.user_id AND r.expires_at_ms > NEW.received_at_ms AND r.outcome IS NULL) >= 100
  OR (SELECT count(*) FROM forwarded_email_receipts r WHERE r.user_id = NEW.user_id
    AND r.received_at_ms > NEW.received_at_ms - 7776000000) >= 1000
  OR (SELECT count(*) FROM forwarded_email_receipts r
    WHERE r.received_at_ms > NEW.received_at_ms - 7776000000) >= 10000
BEGIN SELECT RAISE(ABORT, 'forwarded_email_capacity'); END;

CREATE TRIGGER erasure_fence_forwarded_email_receipts_insert BEFORE INSERT ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER forwarded_email_deferred_capacity_insert BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN SELECT RAISE(ABORT,'forwarded_email_deferred_capacity'); END;

CREATE TRIGGER forwarded_email_deferred_capacity_update BEFORE UPDATE OF deferred_checked_at_ms ON forwarded_email_receipts
WHEN OLD.deferred_checked_at_ms IS NULL AND NEW.deferred_checked_at_ms IS NOT NULL
 AND (SELECT count(*) FROM forwarded_email_receipts WHERE user_id=NEW.user_id AND deferred_checked_at_ms IS NOT NULL)>=50
BEGIN SELECT RAISE(ABORT,'forwarded_email_deferred_capacity'); END;

CREATE TRIGGER forwarded_email_deferred_expiry AFTER UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state='expired' AND NEW.deferred_checked_at_ms IS NOT NULL
BEGIN UPDATE forwarded_email_receipts SET deferred_checked_at_ms=NULL WHERE id=NEW.id AND user_id=NEW.user_id; END;

CREATE TRIGGER erasure_fence_forwarded_email_receipts_update BEFORE UPDATE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='forwarded_email_receipts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_receipts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'state',OLD."state",'received_at_ms',OLD."received_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'deferred_checked_at_ms',OLD."deferred_checked_at_ms",'outcome',OLD.outcome,'outcome_transaction_id',OLD.outcome_transaction_id,'outcome_review_id',OLD.outcome_review_id,'outcome_completed_at_ms',OLD.outcome_completed_at_ms,'review_id',OLD.review_id,'review_reason',OLD.review_reason,'review_created_at_ms',OLD.review_created_at_ms,'review_evidence_expires_at_ms',OLD.review_evidence_expires_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

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
BEGIN SELECT RAISE(ABORT, 'forwarded_email_authority'); END;

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

CREATE UNIQUE INDEX forwarded_email_review_identity ON forwarded_email_receipts(review_id) WHERE review_id IS NOT NULL;

CREATE INDEX forwarded_email_review_by_user ON forwarded_email_receipts(user_id,review_created_at_ms DESC) WHERE review_id IS NOT NULL;

CREATE TRIGGER forwarded_email_outcome_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.outcome IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.outcome IS NOT OLD.outcome OR NEW.outcome_transaction_id IS NOT OLD.outcome_transaction_id OR NEW.outcome_review_id IS NOT OLD.outcome_review_id OR NEW.outcome_completed_at_ms IS NOT OLD.outcome_completed_at_ms) BEGIN SELECT RAISE(ABORT,'email_record_append_only'); END;

CREATE TRIGGER forwarded_email_review_no_update BEFORE UPDATE ON forwarded_email_receipts WHEN OLD.review_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.review_id IS NOT OLD.review_id OR NEW.review_reason IS NOT OLD.review_reason OR NEW.review_created_at_ms IS NOT OLD.review_created_at_ms OR NEW.review_evidence_expires_at_ms IS NOT OLD.review_evidence_expires_at_ms) BEGIN SELECT RAISE(ABORT,'email_record_append_only'); END;

CREATE TRIGGER forwarded_email_companions_valid_insert BEFORE INSERT ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN SELECT RAISE(ABORT,'email_record_invalid'); END;

CREATE TRIGGER forwarded_email_companions_valid_update BEFORE UPDATE ON forwarded_email_receipts WHEN coalesce(((NEW.outcome IS NULL AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id IS NULL AND NEW.outcome_completed_at_ms IS NULL) OR (NEW.outcome_completed_at_ms IS NOT NULL AND ((NEW.outcome='accepted' AND NEW.outcome_transaction_id IS NOT NULL AND NEW.outcome_review_id IS NULL AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.outcome_transaction_id AND t.user_id=NEW.user_id)) OR (NEW.outcome='needs-review' AND NEW.outcome_transaction_id IS NULL AND NEW.outcome_review_id=NEW.review_id)))) AND ((NEW.review_id IS NULL AND NEW.review_reason IS NULL AND NEW.review_created_at_ms IS NULL AND NEW.review_evidence_expires_at_ms IS NULL) OR (NEW.review_id IS NOT NULL AND NEW.review_reason IN ('unsupported-content','unknown-format','ambiguous-format','invalid-format','canonical-validation-failed','processing-interrupted','consent-revoked') AND NEW.review_created_at_ms IS NOT NULL AND NEW.review_evidence_expires_at_ms IS NOT NULL)),0)=0 BEGIN SELECT RAISE(ABORT,'email_record_invalid'); END;

CREATE TRIGGER forwarded_email_completion_initial BEFORE INSERT ON forwarded_email_receipts
WHEN NEW.outcome IS NOT NULL OR NEW.review_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'email_record_invalid'); END;

CREATE TRIGGER forwarded_email_completed_no_delete BEFORE DELETE ON forwarded_email_receipts
WHEN (OLD.outcome IS NOT NULL OR OLD.review_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='forwarded_email_receipts' AND p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'email_record_append_only'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_email_companions',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_email_companions';

PRAGMA defer_foreign_keys=OFF;
