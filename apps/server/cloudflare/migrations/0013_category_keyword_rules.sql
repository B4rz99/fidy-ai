-- User-owned Category keyword rules categorize future capture only. They never rewrite a
-- Transaction: capture reads the rules at insert time, so editing or deleting one cannot
-- touch history. Rules name a stable CategoryId rather than a label or a seed position.
CREATE TABLE keyword_rules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL CHECK (length(normalized_keyword) > 0),
  category_id TEXT NOT NULL REFERENCES categories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, normalized_keyword)
) STRICT;
CREATE INDEX keyword_rules_by_user ON keyword_rules(user_id, created_at, id);
-- The bounded set is a stable-User guarantee. Core decides the same 100-rule maximum; this
-- trigger remains the atomic authority under concurrent creation.
CREATE TRIGGER keyword_rule_capacity BEFORE INSERT ON keyword_rules
WHEN (SELECT COUNT(*) FROM keyword_rules WHERE user_id = NEW.user_id) >= 100
BEGIN SELECT RAISE(ABORT, 'keyword_rule_limit'); END;
-- SQLite cannot alter a CHECK constraint. Rebuild the append-only Category audit so keyword-rule
-- mutations are attributable without discarding existing Category read evidence.
DROP TRIGGER transaction_audit_daily_budget;
DROP TRIGGER pat_canonical_daily_budget;
DROP TRIGGER category_canonical_daily_budget;
CREATE TABLE category_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN (
    'categories.listCategories',
    'categories.listKeywordRules',
    'categories.createKeywordRule',
    'categories.updateKeywordRule',
    'categories.deleteKeywordRule')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO category_audit_next SELECT id, user_id, session_id, operation, occurred_at_ms FROM category_audit;
DROP TABLE category_audit;
ALTER TABLE category_audit_next RENAME TO category_audit;
CREATE INDEX category_audit_by_user_day ON category_audit(user_id, occurred_at_ms);
CREATE TRIGGER category_audit_no_update BEFORE UPDATE ON category_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER category_audit_no_delete BEFORE DELETE ON category_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN ((NEW.pat_id IS NOT NULL AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation = 'pats.listPATs')
 AND (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM pat_audit WHERE user_id = NEW.user_id
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM category_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
-- A skipped guarded rule audit aborts the whole keyword-rule D1 batch instead of committing
-- a rule change without its accountability evidence.
CREATE TABLE category_mutation_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
