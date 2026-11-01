DROP INDEX audit_entries_media;
--> statement-breakpoint

CREATE INDEX audit_entries_media
  ON audit_entries(media_submission_id)
  WHERE media_submission_id IS NOT NULL;
