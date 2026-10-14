-- Cleared correlation metadata remains evidence but must not remain in the retention workset.
-- Separate deadline branches let each sweep seek to due content and make bounded progress.
CREATE INDEX weekly_question_content_retention
  ON weekly_governor_questions(created_at_ms,id)
  WHERE text IS NOT NULL OR offer_json IS NOT NULL;
CREATE INDEX weekly_question_ready_retention
  ON weekly_governor_questions(state,expires_at_ms,id)
  WHERE state='ready' AND (text IS NOT NULL OR offer_json IS NOT NULL);

CREATE INDEX proactivity_sent_content_retention
  ON proactivity_whatsapp_claims(send_started_at_ms)
  WHERE text IS NOT NULL OR template_json IS NOT NULL;
CREATE INDEX proactivity_staged_content_retention
  ON proactivity_whatsapp_claims(state,expires_at_ms)
  WHERE state='staged' AND (text IS NOT NULL OR template_json IS NOT NULL);

CREATE INDEX insight_sent_content_retention
  ON insight_whatsapp_claims(send_started_at_ms)
  WHERE text IS NOT NULL OR summary_json IS NOT NULL;
CREATE INDEX insight_staged_content_retention
  ON insight_whatsapp_claims(state,expires_at_ms)
  WHERE state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL);
CREATE INDEX insight_user_sent_content_retention
  ON insight_whatsapp_claims(user_id,send_started_at_ms)
  WHERE text IS NOT NULL OR summary_json IS NOT NULL;
CREATE INDEX insight_user_staged_content_retention
  ON insight_whatsapp_claims(user_id,state,expires_at_ms)
  WHERE state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL);

CREATE INDEX media_content_retention
  ON media_submissions(expires_at_ms,id)
  WHERE media_id IS NOT NULL OR caption IS NOT NULL;
CREATE INDEX media_accountability_retention ON media_submissions(accepted_at_ms,id);
-- Publication copies accepted_at_ms into the outbox's created_at_ms in the same D1 unit.
CREATE INDEX media_outbox_retention ON media_submission_outbox(created_at_ms,submission_id);

-- R2-deleted rows referenced by submissions are permanent metadata, never pending work.
CREATE INDEX statement_staging_delete_retention
  ON statement_staging_objects(expires_at_ms,id)
  WHERE status='deleting' AND object_deleted_at_ms IS NULL;
CREATE INDEX statement_staging_unpublished_retention
  ON statement_staging_objects(expires_at_ms,id)
  WHERE status IN ('pending','available') AND object_deleted_at_ms IS NULL;
