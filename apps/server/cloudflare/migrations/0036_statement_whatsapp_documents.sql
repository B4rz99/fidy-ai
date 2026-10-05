-- Authenticated direct attachments survive identity-only hosted work redelivery. No URL,
-- filename, caption or bytes are retained here. Unpublished bytes retain ordinary staging expiry.
CREATE TABLE statement_whatsapp_documents (
  turn_id TEXT PRIMARY KEY NOT NULL REFERENCES hosted_turns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  media_id TEXT NOT NULL CHECK (length(media_id) BETWEEN 1 AND 256),
  staging_id TEXT REFERENCES statement_staging_objects(id) ON DELETE CASCADE,
  upload_grant_id TEXT CHECK (upload_grant_id IS NULL OR length(upload_grant_id) BETWEEN 1 AND 128),
  upload_expires_at_ms INTEGER CHECK (upload_expires_at_ms IS NULL OR upload_expires_at_ms >= 0),
  reference_json TEXT CHECK (reference_json IS NULL OR (json_valid(reference_json) AND length(reference_json) <= 4096)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK ((upload_grant_id IS NULL) = (upload_expires_at_ms IS NULL)),
  CHECK ((staging_id IS NULL) = (reference_json IS NULL))
) STRICT;
CREATE TRIGGER statement_document_immutable BEFORE UPDATE ON statement_whatsapp_documents
WHEN NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.media_id <> OLD.media_id
  OR NEW.created_at_ms <> OLD.created_at_ms
  OR (OLD.staging_id IS NOT NULL AND (NEW.staging_id IS NOT OLD.staging_id OR NEW.reference_json IS NOT OLD.reference_json))
  OR (NEW.staging_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM statement_staging_objects
    WHERE id = NEW.staging_id AND user_id = NEW.user_id))
BEGIN SELECT RAISE(ABORT, 'statement_document_immutable'); END;

-- Publication retains only its origin and canonical result. The provider locator and the
-- private staging reference are no longer needed, including for identity-only Turn recovery.
CREATE TRIGGER statement_document_published AFTER INSERT ON statement_hosted_origins
BEGIN DELETE FROM statement_whatsapp_documents WHERE turn_id=NEW.turn_id AND user_id=NEW.user_id; END;

-- Review rows retain their own bounded evidence and the staging digest remains available for
-- canonical SourceAttestation. The entire uploaded file is unnecessary after machine extraction.
-- Retire it in the terminal D1 unit so the existing resumable R2 sweep cannot strand published bytes.
CREATE TRIGGER statement_terminal_material AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing')
BEGIN
  UPDATE statement_staging_objects SET status='deleting',published_submission_id=NULL
  WHERE id=NEW.staging_id AND user_id=NEW.user_id AND status='published'
    AND object_deleted_at_ms IS NULL;
END;
