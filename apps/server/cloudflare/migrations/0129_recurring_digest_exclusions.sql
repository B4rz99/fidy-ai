-- Keep the exact historical digest exclusions on their immutable confirmation rows.
-- Do not infer exclusions from malformed snapshots inserted after the original migration.
DROP TRIGGER recurring_confirmation_no_update;

ALTER TABLE recurring_confirmations ADD COLUMN digest_excluded INTEGER NOT NULL DEFAULT 0 CHECK(digest_excluded IN(0,1));

UPDATE recurring_confirmations SET digest_excluded=1 WHERE EXISTS(
 SELECT 1 FROM recurring_legacy_confirmations l WHERE l.user_id=recurring_confirmations.user_id AND l.confirmation_id=recurring_confirmations.id);

DROP TRIGGER IF EXISTS recurring_legacy_no_update;

DROP TRIGGER IF EXISTS recurring_legacy_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_recurring_legacy_confirmations_insert;

DROP TRIGGER IF EXISTS erasure_fence_recurring_legacy_confirmations_update;

DROP TRIGGER IF EXISTS erasure_fence_recurring_legacy_confirmations_delete;

DROP TRIGGER IF EXISTS erasure_preserve_recurring_legacy_confirmations_delete;

DROP TABLE recurring_legacy_confirmations;

CREATE TRIGGER recurring_confirmation_no_update BEFORE UPDATE ON recurring_confirmations BEGIN
  SELECT RAISE(ABORT, 'recurring_confirmation_immutable');
END;

DROP TRIGGER IF EXISTS erasure_preserve_recurring_confirmations_delete;

CREATE TRIGGER erasure_preserve_recurring_confirmations_delete BEFORE DELETE ON recurring_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_confirmations','drain:'||lower(hex(randomblob(16))),json_object('digest_excluded',OLD.digest_excluded,'user_id',OLD."user_id",'id',OLD."id",'series_id',OLD."series_id",'confirmed_at',OLD."confirmed_at",'context_json',OLD."context_json",'confirmation_json',OLD."confirmation_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
