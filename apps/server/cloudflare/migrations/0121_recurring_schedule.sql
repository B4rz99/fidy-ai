-- Keep the discovery wakeup with its existing fair-dispatch cursor; no additional job store.
ALTER TABLE recurring_dispatch ADD COLUMN next_discovery_at_ms INTEGER NOT NULL DEFAULT 0;

CREATE INDEX recurring_unfinished_users ON recurring_progress(user_id) WHERE phase<>'complete';

DROP TRIGGER IF EXISTS erasure_preserve_recurring_dispatch_delete;

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
