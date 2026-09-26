-- Widen terminal failures without rebuilding the FK-referenced submission table. The old
-- constrained column remains as historical evidence; only the new column drives public state.
DROP TRIGGER statement_submission_state_insert;
DROP TRIGGER statement_submission_state_update;
ALTER TABLE statement_submissions RENAME COLUMN failure_reason TO legacy_failure_reason;
ALTER TABLE statement_submissions ADD COLUMN failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason IN ('unsupported-format', 'resource-limit',
    'malformed-file', 'mapping-unavailable', 'retention-expired'));
UPDATE statement_submissions SET failure_reason = legacy_failure_reason;
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
      AND ((NEW.input_rows IS NULL AND NEW.accepted_rows IS NULL AND NEW.needs_review_rows IS NULL)
        OR (NEW.input_rows > 0 AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)))
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
      AND ((NEW.input_rows IS NULL AND NEW.accepted_rows IS NULL AND NEW.needs_review_rows IS NULL)
        OR (NEW.input_rows > 0 AND NEW.input_rows = NEW.accepted_rows + NEW.needs_review_rows)))
  )
), 0) = 0
BEGIN SELECT RAISE(ABORT, 'statement_submission_state'); END;

-- Statement-line evidence is immutable and identifies one source record, not just its Transaction.
-- Preserve the manual attestation table while widening its closed kind vocabulary.
CREATE TABLE source_attestations_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'statement-line')),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  interpretation_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  statement_submission_id TEXT,
  statement_record_number INTEGER,
  statement_content_hash TEXT,
  source_format TEXT,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (statement_submission_id) REFERENCES statement_submissions(id),
  CHECK ((kind = 'manual' AND statement_submission_id IS NULL AND statement_record_number IS NULL
    AND statement_content_hash IS NULL AND source_format IS NULL) OR
    (kind = 'statement-line' AND statement_submission_id IS NOT NULL
    AND statement_record_number > 0 AND length(statement_content_hash) = 64
    AND source_format IN ('csv', 'xlsx'))),
  UNIQUE (statement_submission_id, statement_record_number)
) STRICT;
INSERT INTO source_attestations_next (id, user_id, transaction_id, kind, service_market,
  locale, time_zone, interpretation_revision, created_at)
SELECT id, user_id, transaction_id, kind, service_market, locale, time_zone,
  interpretation_revision, created_at FROM source_attestations;
DROP TABLE source_attestations;
ALTER TABLE source_attestations_next RENAME TO source_attestations;
CREATE INDEX source_attestations_by_transaction ON source_attestations(user_id, transaction_id);
CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
CREATE TRIGGER source_attestation_no_delete BEFORE DELETE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;

-- One outcome per source row. The composite foreign key prevents crossing a submission's User.
CREATE UNIQUE INDEX statement_submissions_owned ON statement_submissions(user_id, id);
CREATE TABLE statement_record_outcomes (
  user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_number INTEGER NOT NULL CHECK (record_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'needs-review')),
  transaction_id TEXT,
  PRIMARY KEY (submission_id, record_number),
  FOREIGN KEY (user_id, submission_id) REFERENCES statement_submissions(user_id, id),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  CHECK ((outcome = 'accepted') = (transaction_id IS NOT NULL))
) STRICT;
-- Existing retention sweep settles old processing rows without knowing how many rows already
-- finalized. Derive its partial accounting atomically at the terminal transition.
CREATE TRIGGER statement_partial_accounting_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
  AND NEW.input_rows IS NULL
  AND EXISTS (SELECT 1 FROM statement_record_outcomes
    WHERE submission_id = NEW.id AND user_id = NEW.user_id)
BEGIN
  UPDATE statement_submissions SET
    input_rows = (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = NEW.id),
    accepted_rows = (SELECT count(*) FROM statement_record_outcomes
      WHERE submission_id = NEW.id AND outcome = 'accepted'),
    needs_review_rows = (SELECT count(*) FROM statement_record_outcomes
      WHERE submission_id = NEW.id AND outcome = 'needs-review')
    WHERE id = NEW.id AND user_id = NEW.user_id;
END;
-- The existing retention sweep releases only unconsumed Free reservations. Partial finalized
-- results are useful and must spend the grant even when the submission later fails.
CREATE TRIGGER statement_partial_backfill_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
  AND EXISTS (SELECT 1 FROM statement_record_outcomes
    WHERE submission_id = NEW.id AND user_id = NEW.user_id)
BEGIN
  UPDATE statement_backfill_entitlements SET consumed_at_ms = NEW.completed_at_ms
    WHERE user_id = NEW.user_id AND submission_id = NEW.id AND consumed_at_ms IS NULL;
END;
CREATE TRIGGER statement_record_outcome_no_update BEFORE UPDATE ON statement_record_outcomes
BEGIN SELECT RAISE(ABORT, 'statement_outcome_append_only'); END;
CREATE TRIGGER statement_record_outcome_no_delete BEFORE DELETE ON statement_record_outcomes
BEGIN SELECT RAISE(ABORT, 'statement_outcome_append_only'); END;

-- Review material remains User-bound and is independently expired by the retention sweep.
CREATE TABLE statement_needs_review (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_number INTEGER NOT NULL CHECK (record_number > 0),
  reason TEXT NOT NULL CHECK (reason IN ('malformed-source-row', 'missing-required-fact',
    'ambiguous-direction', 'ambiguous-currency', 'canonical-validation-failed',
    'mapping-unavailable', 'model-unavailable')),
  original_evidence TEXT,
  known_money TEXT,
  issues TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'expired', 'resolved')),
  evidence_expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('csv', 'xlsx')),
  parser_revision TEXT NOT NULL,
  extractor_revision TEXT NOT NULL,
  UNIQUE (submission_id, record_number),
  FOREIGN KEY (user_id, submission_id) REFERENCES statement_submissions(user_id, id),
  CHECK ((status = 'pending') = (original_evidence IS NOT NULL))
) STRICT;
CREATE INDEX statement_review_expiry ON statement_needs_review(evidence_expires_at_ms)
  WHERE status = 'pending';
-- One cron activation can clear the full raw-evidence capacity. Under excess global demand,
-- capture a visible expired review item instead of retaining evidence beyond that capacity.
CREATE TRIGGER statement_review_pending_cap BEFORE INSERT ON statement_needs_review
WHEN NEW.status = 'pending' AND
  (SELECT count(*) FROM statement_needs_review WHERE status = 'pending') >= 5000
BEGIN SELECT RAISE(ABORT, 'statement_review_capacity'); END;
-- No third party can replace evidence or lifecycle accidentally; only the explicit expiry transition.
CREATE TRIGGER statement_review_expiry_only BEFORE UPDATE ON statement_needs_review
WHEN NOT (OLD.status = 'pending' AND NEW.status = 'expired' AND NEW.original_evidence IS NULL
  AND NEW.known_money IS NULL AND NEW.issues = OLD.issues
  AND NEW.id = OLD.id AND NEW.user_id = OLD.user_id AND NEW.submission_id = OLD.submission_id
  AND NEW.record_number = OLD.record_number AND NEW.reason = OLD.reason
  AND NEW.evidence_expires_at_ms = OLD.evidence_expires_at_ms
  AND NEW.created_at_ms = OLD.created_at_ms AND NEW.service_market = OLD.service_market
  AND NEW.locale = OLD.locale AND NEW.time_zone = OLD.time_zone
  AND NEW.source_format = OLD.source_format AND NEW.parser_revision = OLD.parser_revision
  AND NEW.extractor_revision = OLD.extractor_revision)
BEGIN SELECT RAISE(ABORT, 'review_immutable'); END;
