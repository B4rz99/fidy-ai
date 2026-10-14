-- Durable Memory: formatting-normalized User-chosen prose retained only for the
-- durable-economic-context purpose. Revision replaces text in place and forgetting physically
-- removes it, so every stored row is a current Memory and recall is current-only.
CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, id)
) STRICT;
CREATE INDEX memories_by_user_creation ON memories(user_id, created_at, id);
-- Aggregate capacity is the exact UTF-8 byte length of the recall-ordered `{id,text}` projection
-- that the Memory owner counts (15,000 in core/memory/rules.ts). D1 stays the atomic authority so
-- concurrent writes cannot oversubscribe the bound; the owner preflight produces the typed quota
-- failure. Order does not change the sum, so the guard counts projected rows directly.
CREATE TRIGGER memory_capacity_before_insert BEFORE INSERT ON memories
WHEN (SELECT COALESCE(SUM(length(CAST(json_object('id', id, 'text', text) AS BLOB))), 0)
        FROM memories WHERE user_id = NEW.user_id)
   + length(CAST(json_object('id', NEW.id, 'text', NEW.text) AS BLOB))
   + (SELECT COUNT(*) FROM memories WHERE user_id = NEW.user_id) > 15000
BEGIN SELECT RAISE(ABORT, 'memory_capacity_exceeded'); END;
CREATE TRIGGER memory_capacity_before_revision BEFORE UPDATE OF text ON memories
WHEN (SELECT COALESCE(SUM(length(CAST(json_object('id', id, 'text', text) AS BLOB))), 0)
        FROM memories WHERE user_id = NEW.user_id AND id <> NEW.id)
   + length(CAST(json_object('id', NEW.id, 'text', NEW.text) AS BLOB))
   + (SELECT COUNT(*) FROM memories WHERE user_id = NEW.user_id) - 1 > 15000
BEGIN SELECT RAISE(ABORT, 'memory_capacity_exceeded'); END;
-- One metadata-only AuditLogEntry for each authenticated browser Memory call. It never stores the
-- Memory identifier or its prose, only who, which operation, what outcome, and when.
CREATE TABLE memory_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('memory.remember', 'memory.recall', 'memory.revise', 'memory.forget')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'not_found', 'validation_failed', 'resource_limit')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX memory_audit_by_user_day ON memory_audit(user_id, occurred_at_ms);
CREATE TRIGGER memory_audit_no_update BEFORE UPDATE ON memory_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
CREATE TRIGGER memory_audit_no_delete BEFORE DELETE ON memory_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
-- A skipped guarded Memory audit aborts the complete batch instead of committing a partial effect.
CREATE TABLE memory_atomic_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
-- Memory joins the shared stable-User canonical work budget (256 entries per UTC day) so multiple
-- credentials or channels cannot multiply it. Rebuild every trigger to count memory_audit too.
DROP TRIGGER transaction_audit_daily_budget;
DROP TRIGGER pat_canonical_daily_budget;
DROP TRIGGER category_canonical_daily_budget;
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
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
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
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
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
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000)
   + (SELECT COUNT(*) FROM memory_audit WHERE user_id = NEW.user_id
      AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
      AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;
CREATE TRIGGER memory_canonical_daily_budget BEFORE INSERT ON memory_audit
WHEN (SELECT COUNT(*) FROM transaction_audit WHERE user_id = NEW.user_id
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
