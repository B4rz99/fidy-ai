ALTER TABLE media_submissions ADD COLUMN capacity_held INTEGER NOT NULL DEFAULT 1 CHECK(capacity_held IN (0,1));
UPDATE media_submissions SET capacity_held=0 WHERE NOT EXISTS
  (SELECT 1 FROM media_submission_outbox o WHERE o.submission_id=media_submissions.id);
CREATE INDEX media_capacity_by_user ON media_submissions(user_id) WHERE capacity_held=1;
CREATE INDEX media_capacity_expiry ON media_submissions(expires_at_ms,id) WHERE capacity_held=1;
DROP TABLE media_submission_outbox;
