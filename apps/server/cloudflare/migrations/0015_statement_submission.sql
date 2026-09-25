-- Statement submission acceptance: the authoritative row, its extraction outbox identity, its
-- retention context, and the Free backfill entitlement. Staged bytes stay non-authoritative in
-- statement_staging_objects; only statement_submissions makes them real (#788, ADR 0028).
--
-- The staged source format is sniffed from actual bytes at staging time, so publication never
-- trusts a caller-supplied name, extension, media type, or length.
ALTER TABLE statement_staging_objects ADD COLUMN source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx'));
-- Durable proof that the object this locator named is gone, so an interrupted cleanup resumes
-- instead of re-deleting forever and a referenced row can stay in place.
ALTER TABLE statement_staging_objects ADD COLUMN object_deleted_at_ms INTEGER;

ALTER TABLE statement_submissions ADD COLUMN source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx'));
ALTER TABLE statement_submissions ADD COLUMN parser_revision TEXT;
ALTER TABLE statement_submissions ADD COLUMN service_market TEXT;
ALTER TABLE statement_submissions ADD COLUMN locale TEXT;
ALTER TABLE statement_submissions ADD COLUMN time_zone TEXT;
ALTER TABLE statement_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'processing', 'completed', 'failed'));
ALTER TABLE statement_submissions ADD COLUMN started_at_ms INTEGER;
ALTER TABLE statement_submissions ADD COLUMN completed_at_ms INTEGER;
ALTER TABLE statement_submissions ADD COLUMN failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason IN ('unsupported-format', 'resource-limit',
    'malformed-file', 'mapping-unavailable', 'retention-expired'));
ALTER TABLE statement_submissions ADD COLUMN input_rows INTEGER;
ALTER TABLE statement_submissions ADD COLUMN accepted_rows INTEGER;
ALTER TABLE statement_submissions ADD COLUMN needs_review_rows INTEGER;
-- Bounded lifetime of the submission's staged material. A submission that outlives this bound
-- without a useful outcome is failed as retention-expired and its object is reclaimed.
ALTER TABLE statement_submissions ADD COLUMN retention_expires_at_ms INTEGER;

-- One submission lifecycle, enforced for every writer rather than only the publication adapter.
CREATE TRIGGER statement_submission_state_insert BEFORE INSERT ON statement_submissions
WHEN coalesce((
  NEW.source_format IS NOT NULL AND NEW.parser_revision IS NOT NULL
  AND NEW.service_market IS NOT NULL AND NEW.locale IS NOT NULL AND NEW.time_zone IS NOT NULL
  AND NEW.retention_expires_at_ms > NEW.submitted_at_ms
  AND (
    (NEW.status = 'queued' AND NEW.started_at_ms IS NULL AND NEW.completed_at_ms IS NULL
      AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'processing' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NULL AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'completed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NULL
      AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)
    OR (NEW.status = 'failed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NOT NULL
      AND NEW.input_rows IS NULL)
  )
), 0) = 0
BEGIN SELECT RAISE(ABORT, 'statement_submission_state'); END;

CREATE TRIGGER statement_submission_state_update BEFORE UPDATE ON statement_submissions
WHEN coalesce((
  NEW.source_format IS NOT NULL AND NEW.parser_revision IS NOT NULL
  AND NEW.service_market IS NOT NULL AND NEW.locale IS NOT NULL AND NEW.time_zone IS NOT NULL
  AND NEW.retention_expires_at_ms > NEW.submitted_at_ms
  AND (
    (NEW.status = 'queued' AND NEW.started_at_ms IS NULL AND NEW.completed_at_ms IS NULL
      AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'processing' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NULL AND NEW.failure_reason IS NULL AND NEW.input_rows IS NULL)
    OR (NEW.status = 'completed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NULL
      AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)
    OR (NEW.status = 'failed' AND NEW.started_at_ms IS NOT NULL
      AND NEW.completed_at_ms IS NOT NULL AND NEW.failure_reason IS NOT NULL
      AND NEW.input_rows IS NULL)
  )
), 0) = 0
BEGIN SELECT RAISE(ABORT, 'statement_submission_state'); END;

-- Bounded cleanup reads only submissions that have outlived their retention without a useful
-- outcome, so an interrupted extraction cannot hold staged material past its bound.
CREATE INDEX statement_submissions_retention
  ON statement_submissions(retention_expires_at_ms)
  WHERE status IN ('queued', 'processing');
-- Admission pressure reads one User's outstanding and rolling-hour submissions.
CREATE INDEX statement_submissions_user_submitted
  ON statement_submissions(user_id, submitted_at_ms);

-- A canonical read of one submission is attributable like every other canonical call. SQLite cannot
-- widen a CHECK in place, so the append-only audit table is rebuilt with the read operation, its
-- bounded not-found outcome, and the two bounded refusal outcomes, preserving every existing row
-- and both append-only triggers.
CREATE TABLE statement_submission_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation IN ('ingestion.submitForExtraction',
    'ingestion.getStatementSubmission')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed',
    'resource_limit')),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
INSERT INTO statement_submission_audit_next (id, user_id, operation, outcome, occurred_at_ms)
  SELECT id, user_id, operation, outcome, occurred_at_ms FROM statement_submission_audit;
DROP TABLE statement_submission_audit;
ALTER TABLE statement_submission_audit_next RENAME TO statement_submission_audit;
CREATE INDEX statement_audit_by_user_day ON statement_submission_audit(user_id, occurred_at_ms);
CREATE TRIGGER statement_submission_audit_no_update BEFORE UPDATE ON statement_submission_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER statement_submission_audit_no_delete BEFORE DELETE ON statement_submission_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

-- Statement submission joins the shared 256-entry stable-User daily canonical work budget the other
-- canonical audit tables share (0011_transaction_corrections.sql, 0014_memory.sql), so multiple
-- credentials or channels cannot multiply it and an authenticated loop cannot grow an append-only
-- table without a bound. Every trigger is rebuilt to count all five tables, and the 86400000 day
-- boundary stays UTC like the rest. The statement marker stays distinct so the adapter can answer a
-- spent budget as a bounded rate limit.
CREATE TRIGGER statement_audit_daily_budget BEFORE INSERT ON statement_submission_audit
WHEN (SELECT COUNT(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'statement_audit_limit'); END;
DROP TRIGGER transaction_audit_daily_budget;
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN (SELECT COUNT(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER pat_canonical_daily_budget;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs')
 AND (SELECT COUNT(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER category_canonical_daily_budget;
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (SELECT COUNT(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER memory_canonical_daily_budget;
CREATE TRIGGER memory_canonical_daily_budget BEFORE INSERT ON memory_audit
WHEN (SELECT COUNT(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

-- The Free statement backfill: one lifetime extraction. `submission_id` holds the one outstanding
-- reservation, cleared by a failed outcome or retention expiry; `consumed_at_ms` is set only when
-- an extraction produced a useful outcome. A User with no row, or a row with neither column set,
-- still holds the grant.
CREATE TABLE statement_backfill_entitlements (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  submission_id TEXT REFERENCES statement_submissions(id),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= 0)
) STRICT;

-- Bounded, identity-only extraction work published atomically with its submission. Delivery and
-- settlement belong to the statement extraction Workflow, which reads this identity rather than
-- any statement content.
CREATE TABLE statement_ingestion_outbox (
  submission_id TEXT PRIMARY KEY NOT NULL REFERENCES statement_submissions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision = 1),
  published_at_ms INTEGER NOT NULL CHECK (published_at_ms >= 0)
) STRICT;

-- A skipped guarded publication step aborts the complete D1 unit instead of committing a
-- submission without its staging promotion, entitlement reservation, Audit, or outbox identity.
-- The named constraint is the stable refusal marker the adapter classifies a lost unit with.
CREATE TABLE statement_submission_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  accepted INTEGER NOT NULL,
  CONSTRAINT statement_submission_refused CHECK (accepted = 1)
) STRICT;
