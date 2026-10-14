-- A failed Queue offer leaves the authoritative intent in place. Cooldown claims bound repeated
-- delivery attempts across concurrent scheduled Workers; Workflow identity is the submission id.
ALTER TABLE statement_ingestion_outbox ADD COLUMN last_attempt_at_ms INTEGER
  CHECK (last_attempt_at_ms IS NULL OR last_attempt_at_ms >= 0);
CREATE INDEX statement_ingestion_outbox_attempt
  ON statement_ingestion_outbox(last_attempt_at_ms, published_at_ms, submission_id);

-- Canonical review reads need their own true operation identity without rewriting the historical
-- submission audit. Include them in the same stable-User daily work budget as every other call.
CREATE TABLE statement_review_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation = 'ingestion.listNeedsReviewItems'),
  outcome TEXT NOT NULL CHECK (outcome = 'success'),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
CREATE INDEX statement_review_audit_by_user_day ON statement_review_audit(user_id, occurred_at_ms);
CREATE TRIGGER statement_review_audit_no_update BEFORE UPDATE ON statement_review_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER statement_review_audit_no_delete BEFORE DELETE ON statement_review_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

-- Deliberately spell out the aggregate in each table's BEFORE INSERT trigger. SQLite cannot
-- parameterize NEW.user_id/time through a shared view or trigger body, and a cross-User aggregate
-- view would scan unrelated audits on every write. Keep all six sources identical when extending
-- this daily budget; insertion in any table must count writes from every other table.
DROP TRIGGER statement_audit_daily_budget;
CREATE TRIGGER statement_audit_daily_budget BEFORE INSERT ON statement_submission_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'statement_audit_limit'); END;
DROP TRIGGER transaction_audit_daily_budget;
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER pat_canonical_daily_budget;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs') AND (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER category_canonical_daily_budget;
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
DROP TRIGGER memory_canonical_daily_budget;
CREATE TRIGGER memory_canonical_daily_budget BEFORE INSERT ON memory_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER statement_review_audit_daily_budget BEFORE INSERT ON statement_review_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM category_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM memory_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM statement_review_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
) >= 256
BEGIN SELECT RAISE(ABORT, 'statement_audit_limit'); END;
