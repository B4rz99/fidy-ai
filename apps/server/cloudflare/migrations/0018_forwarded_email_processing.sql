-- One terminal result per delivered email. The receipt and its opaque object stay private until
-- retention; no Queue identity or R2 key is ever sufficient to authorize a different User.
CREATE TABLE forwarded_email_outcomes (
  receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES forwarded_email_receipts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'needs-review')),
  transaction_id TEXT,
  review_id TEXT,
  completed_at_ms INTEGER NOT NULL,
  CHECK ((outcome = 'accepted' AND transaction_id IS NOT NULL AND review_id IS NULL)
    OR (outcome = 'needs-review' AND transaction_id IS NULL AND review_id IS NOT NULL)),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id)
) STRICT;
CREATE UNIQUE INDEX forwarded_email_receipts_owned ON forwarded_email_receipts(user_id, id);
CREATE TABLE forwarded_email_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
CREATE TRIGGER forwarded_email_outcome_consent BEFORE INSERT ON forwarded_email_outcomes
WHEN NOT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.receipt_id AND user_id = NEW.user_id AND state = 'queued'
      AND (expires_at_ms > NEW.completed_at_ms OR (NEW.outcome = 'needs-review'
        AND EXISTS (SELECT 1 FROM forwarded_email_needs_review e
          WHERE e.id = NEW.review_id AND e.reason = 'processing-interrupted'))))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_authority'); END;
CREATE TRIGGER forwarded_email_outcome_no_update BEFORE UPDATE ON forwarded_email_outcomes
BEGIN SELECT RAISE(ABORT, 'email_outcome_append_only'); END;
CREATE TRIGGER forwarded_email_outcome_no_delete BEFORE DELETE ON forwarded_email_outcomes
BEGIN SELECT RAISE(ABORT, 'email_outcome_append_only'); END;

CREATE TABLE forwarded_email_needs_review (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('unsupported-content', 'unknown-format',
    'ambiguous-format', 'invalid-format', 'canonical-validation-failed',
    'processing-interrupted')),
  created_at_ms INTEGER NOT NULL,
  evidence_expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id, receipt_id) REFERENCES forwarded_email_receipts(user_id, id)
) STRICT;
CREATE INDEX forwarded_email_review_by_user ON forwarded_email_needs_review(user_id, created_at_ms DESC);
CREATE TRIGGER forwarded_email_review_no_update BEFORE UPDATE ON forwarded_email_needs_review
BEGIN SELECT RAISE(ABORT, 'email_review_append_only'); END;
CREATE TRIGGER forwarded_email_review_no_delete BEFORE DELETE ON forwarded_email_needs_review
BEGIN SELECT RAISE(ABORT, 'email_review_append_only'); END;

-- Rebuild immutable attestations to add a closed forwarded-email source kind.
DROP TRIGGER source_attestation_no_update;
DROP TRIGGER source_attestation_no_delete;
CREATE TABLE source_attestations_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'statement-line', 'notification-email')),
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  interpretation_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  statement_submission_id TEXT,
  statement_record_number INTEGER,
  statement_content_hash TEXT,
  source_format TEXT,
  received_email_id TEXT,
  message_content_sha256 TEXT,
  message_evidence TEXT,
  deterministic_interpretation TEXT,
  extractor_revision TEXT,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id),
  FOREIGN KEY (statement_submission_id) REFERENCES statement_submissions(id),
  FOREIGN KEY (user_id, received_email_id) REFERENCES forwarded_email_receipts(user_id, id),
  CHECK ((kind = 'manual' AND statement_submission_id IS NULL AND statement_record_number IS NULL
    AND statement_content_hash IS NULL AND source_format IS NULL AND received_email_id IS NULL)
    OR (kind = 'statement-line' AND statement_submission_id IS NOT NULL
      AND statement_record_number > 0 AND length(statement_content_hash) = 64
      AND source_format IN ('csv', 'xlsx') AND received_email_id IS NULL)
    OR (kind = 'notification-email' AND statement_submission_id IS NULL
      AND statement_record_number IS NULL AND statement_content_hash IS NULL
      AND received_email_id IS NOT NULL AND length(message_content_sha256) = 64
      AND message_evidence IS NOT NULL AND deterministic_interpretation IS NOT NULL
      AND extractor_revision IS NOT NULL AND source_format = 'notification-email')),
  UNIQUE (statement_submission_id, statement_record_number),
  UNIQUE (received_email_id)
) STRICT;
INSERT INTO source_attestations_next (id, user_id, transaction_id, kind, service_market,
  locale, time_zone, interpretation_revision, created_at, statement_submission_id,
  statement_record_number, statement_content_hash, source_format)
SELECT id, user_id, transaction_id, kind, service_market, locale, time_zone,
  interpretation_revision, created_at, statement_submission_id, statement_record_number,
  statement_content_hash, source_format FROM source_attestations;
DROP TABLE source_attestations;
ALTER TABLE source_attestations_next RENAME TO source_attestations;
CREATE INDEX source_attestations_by_transaction ON source_attestations(user_id, transaction_id);
CREATE TRIGGER source_attestation_no_update BEFORE UPDATE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;
CREATE TRIGGER source_attestation_no_delete BEFORE DELETE ON source_attestations
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;

-- A closed, allowlisted tag histogram contains no text, attributes, addresses, amounts, or
-- receipt linkage. It is the only email sample eligible for indefinite retention.
CREATE TABLE anonymized_email_samples (
  id TEXT PRIMARY KEY NOT NULL,
  service_market TEXT NOT NULL CHECK (service_market = 'CO'),
  source_format TEXT NOT NULL CHECK (source_format = 'notification-email'),
  source_provider TEXT NOT NULL CHECK (source_provider = 'cloudflare-email'),
  parser_revision TEXT NOT NULL CHECK (parser_revision = 'cloudflare-mime-v1'),
  anonymization_revision TEXT NOT NULL CHECK (anonymization_revision = 'structural-tags-v1'),
  structure TEXT NOT NULL CHECK (length(structure) BETWEEN 2 AND 256),
  approved_at_ms INTEGER NOT NULL,
  retained_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER anonymized_email_sample_no_update BEFORE UPDATE ON anonymized_email_samples
BEGIN SELECT RAISE(ABORT, 'sample_append_only'); END;
CREATE TRIGGER anonymized_email_sample_no_delete BEFORE DELETE ON anonymized_email_samples
BEGIN SELECT RAISE(ABORT, 'sample_append_only'); END;

-- Terminal outcomes release outstanding capacity; raw bytes still expire on their original date.
DROP TRIGGER forwarded_email_capacity;
CREATE TRIGGER forwarded_email_capacity BEFORE INSERT ON forwarded_email_receipts
WHEN (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.expires_at_ms > NEW.received_at_ms AND NOT EXISTS
  (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)) >= 1000
  OR (SELECT count(*) FROM forwarded_email_receipts r WHERE r.state IN ('storing', 'queued')
  AND r.user_id = NEW.user_id AND r.expires_at_ms > NEW.received_at_ms AND NOT EXISTS
  (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)) >= 100
BEGIN SELECT RAISE(ABORT, 'forwarded_email_capacity'); END;
