-- The last quota check is the deferral marker and fair-sweep cursor. Admission rechecks upgrades immediately.
ALTER TABLE forwarded_email_receipts ADD COLUMN deferred_checked_at_ms INTEGER;

DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_receipts_update;

UPDATE forwarded_email_receipts SET deferred_checked_at_ms=(SELECT d.checked_at_ms FROM forwarded_email_deferrals d WHERE d.receipt_id=forwarded_email_receipts.id AND d.user_id=forwarded_email_receipts.user_id);

DROP TRIGGER forwarded_email_deferred_expiry;

DROP TRIGGER IF EXISTS forwarded_email_deferred_capacity;
DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_deferrals_insert;
DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_deferrals_update;
DROP TRIGGER IF EXISTS erasure_fence_forwarded_email_deferrals_delete;
DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_deferrals_delete;

DROP TABLE forwarded_email_deferrals;

CREATE INDEX forwarded_email_deferred_user ON forwarded_email_receipts(user_id) WHERE deferred_checked_at_ms IS NOT NULL;

CREATE INDEX forwarded_email_deferred_activation ON forwarded_email_receipts(state,deferred_checked_at_ms,id) WHERE deferred_checked_at_ms IS NOT NULL;

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

DROP TRIGGER IF EXISTS erasure_preserve_forwarded_email_receipts_delete;

CREATE TRIGGER erasure_preserve_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_receipts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'state',OLD."state",'received_at_ms',OLD."received_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'deferred_checked_at_ms',OLD."deferred_checked_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
