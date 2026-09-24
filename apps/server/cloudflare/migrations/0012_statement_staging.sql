-- Statement bytes are staged in private R2 before any authoritative D1 submission exists. A staging
-- row is non-authoritative: it never grants extraction, is invisible to every other User, and is
-- unreachable once expired. Only statement_submissions, committed after object size and digest
-- verification, makes staged material authoritative.
CREATE TABLE statement_staging_objects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Opaque R2 locator. Stored only here; it is never returned to a caller or derived from identity,
  -- filename, digest, or size, so possessing a staging reference proves nothing without ownership.
  object_key TEXT NOT NULL UNIQUE,
  -- 5242880 mirrors maximumStatementBytes in src/core/ingestion/model.ts.
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1 AND byte_length <= 5242880),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'published', 'deleting')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  -- Pointer to the submission that consumed this material, written only with the published state.
  published_submission_id TEXT,
  CHECK ((status = 'published') = (published_submission_id IS NOT NULL))
) STRICT;
-- Bounded cleanup reads only unpublished expired rows.
CREATE INDEX statement_staging_expiry
  ON statement_staging_objects(expires_at_ms)
  WHERE status != 'published';

-- Authoritative publication of one statement submission. Minimal by design: #698 extends this table
-- with retention context and the extraction outbox identity, and owns the canonical operation.
CREATE TABLE statement_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  staging_id TEXT NOT NULL UNIQUE REFERENCES statement_staging_objects(id),
  submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms >= 0),
  UNIQUE (user_id, idempotency_key)
) STRICT;

-- Metadata-only AuditLogEntry for one successful canonical submission. Never a body: no filename,
-- digest, byte count, or statement content is recorded.
CREATE TABLE statement_submission_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation IN ('ingestion.submitForExtraction')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success')),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
CREATE TRIGGER statement_submission_audit_no_update BEFORE UPDATE ON statement_submission_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER statement_submission_audit_no_delete BEFORE DELETE ON statement_submission_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
