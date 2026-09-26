-- The forwarding-address migration can be applied after the batch/review migrations on
-- databases that already recorded those filenames. It rebuilds statement_submission_audit
-- and reinstalls older budget guards. Restore the complete six-source, batch-aware policy
-- after every historical migration, regardless of their prior application order.
DROP TRIGGER statement_audit_daily_budget;
DROP TRIGGER transaction_audit_daily_budget;
DROP TRIGGER pat_canonical_daily_budget;
DROP TRIGGER category_canonical_daily_budget;
DROP TRIGGER memory_canonical_daily_budget;
DROP TRIGGER IF EXISTS statement_review_audit_daily_budget;
DROP VIEW IF EXISTS canonical_audit_usage;
CREATE TRIGGER statement_audit_daily_budget BEFORE INSERT ON statement_submission_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN NEW.operation != 'operations.executeAtomicBatch' AND (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN NEW.operation != 'operations.executeAtomicBatch' AND ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs') AND (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
CREATE TRIGGER memory_canonical_daily_budget BEFORE INSERT ON memory_audit
WHEN (
  (SELECT count(*) FROM statement_submission_audit WHERE user_id = NEW.user_id
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM transaction_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
    AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
    AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
  + (SELECT count(*) FROM pat_audit WHERE user_id = NEW.user_id
    AND operation != 'operations.executeAtomicBatch' AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
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
