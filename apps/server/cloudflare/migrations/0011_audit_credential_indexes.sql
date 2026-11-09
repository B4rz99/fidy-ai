-- Bound both table scans and retained index entries before changing either index.
SELECT json(CASE WHEN
  count(*)<=25000
  AND coalesce(sum(record_type='credential_call' AND pat_id IS NOT NULL),0)<=2000
  AND coalesce(sum(record_type='credential_call' AND oauth_connection_id IS NOT NULL),0)<=2000
  AND NOT EXISTS (SELECT 1 FROM sqlite_schema LIMIT 1 OFFSET 2048)
  THEN 'true' ELSE '' END)
FROM (
  SELECT record_type,pat_id,oauth_connection_id
  FROM audit_entries ORDER BY sequence LIMIT 25001
);
--> statement-breakpoint

DROP INDEX audit_entries_oauth_activity;
--> statement-breakpoint

CREATE INDEX audit_entries_oauth_activity
  ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC)
  WHERE record_type='credential_call' AND oauth_connection_id IS NOT NULL;
--> statement-breakpoint

DROP INDEX audit_entries_pat_activity;
--> statement-breakpoint

CREATE INDEX audit_entries_pat_activity
  ON audit_entries(user_id,pat_id,occurred_at_ms DESC,id DESC)
  WHERE record_type='credential_call' AND pat_id IS NOT NULL;
