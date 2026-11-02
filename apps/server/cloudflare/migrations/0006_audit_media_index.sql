-- Refuse before schema changes if rebuilding would exceed the admitted Free-tier budget.
SELECT json(CASE WHEN
  NOT EXISTS (SELECT 1 FROM sqlite_schema LIMIT 1 OFFSET 2048)
  AND NOT EXISTS (SELECT 1 FROM audit_entries ORDER BY sequence LIMIT 1 OFFSET 10000)
  AND NOT EXISTS (
    SELECT 1 FROM audit_entries INDEXED BY audit_entries_media
    WHERE media_submission_id IS NOT NULL LIMIT 1 OFFSET 100
  )
  THEN 'true' ELSE '' END);
--> statement-breakpoint

DROP INDEX audit_entries_media;
--> statement-breakpoint

CREATE INDEX audit_entries_media
  ON audit_entries(media_submission_id)
  WHERE media_submission_id IS NOT NULL;
