-- Session-attributed calls share storage. Commercial quotas and request admission own limits;
-- recording accountability evidence does not impose another daily product allowance.
CREATE TABLE session_audit (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL,
 operation TEXT NOT NULL,
 outcome TEXT NOT NULL,
 occurred_at_ms INTEGER NOT NULL,
 -- Dashboard evidence already permits its session row to be absent; other families retain their FK.
 credential_session_id TEXT GENERATED ALWAYS AS
   (CASE WHEN operation NOT GLOB 'dashboard.*' THEN session_id END) VIRTUAL REFERENCES web_sessions(id),
 CHECK((operation IN ('transactions.createTransaction','transactions.listTransactions','transactions.getTransaction','transactions.updateTransaction','transactions.deleteTransaction','transactions.searchTransactions','transactions.linkTransactions','transactions.unlinkTransactions','operations.executeAtomicBatch') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('categories.listCategories','categories.listKeywordRules','categories.createKeywordRule','categories.updateKeywordRule','categories.deleteKeywordRule') AND outcome IN ('success','validation_failed'))
 OR (operation IN ('memory.remember','memory.recall','memory.revise','memory.forget') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','budgets.listBudgets','budgets.getBudget','budgets.getBudgetStatus') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('dashboard.getDashboard','dashboard.getDashboardView','dashboard.listDashboardCatalog','dashboard.applyDashboardEdit','dashboard.initializeDashboard') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('emailAuthentication.requestEmailReplacement','emailAuthentication.completeEmailReplacement') AND outcome IN ('accepted','rejected','replaced')))
) STRICT;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM transaction_audit;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM category_audit;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM memory_audit;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM budget_audit;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM dashboard_audit;

INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) SELECT id,user_id,session_id,'emailAuthentication.'||operation,outcome,occurred_at_ms FROM email_replacement_audit;

DROP TRIGGER IF EXISTS email_replacement_audit_no_update;

DROP TRIGGER IF EXISTS category_audit_no_update;

DROP TRIGGER IF EXISTS memory_audit_no_update;

DROP TRIGGER IF EXISTS budget_audit_no_update;

DROP TRIGGER IF EXISTS budget_audit_daily_budget;

DROP TRIGGER IF EXISTS pat_batch_envelope_daily_budget;

DROP TRIGGER IF EXISTS dashboard_audit_no_update;

DROP TRIGGER IF EXISTS dashboard_audit_daily_budget;

DROP TRIGGER IF EXISTS transaction_audit_no_update;

DROP TRIGGER IF EXISTS session_batch_envelope_daily_budget;

DROP TRIGGER IF EXISTS category_audit_no_delete;

DROP TRIGGER IF EXISTS memory_audit_no_delete;

DROP TRIGGER IF EXISTS budget_audit_no_delete;

DROP TRIGGER IF EXISTS email_replacement_audit_no_delete;

DROP TRIGGER IF EXISTS dashboard_audit_no_delete;

DROP TRIGGER IF EXISTS transaction_audit_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_budget_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_budget_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_budget_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_category_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_category_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_category_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_dashboard_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_dashboard_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_dashboard_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_memory_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_memory_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_memory_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_transaction_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_transaction_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_transaction_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_budget_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_category_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_dashboard_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_email_replacement_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_memory_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_transaction_audit_delete;

DROP VIEW IF EXISTS canonical_audit_usage;

DROP TRIGGER IF EXISTS category_canonical_daily_budget;

DROP TRIGGER IF EXISTS memory_canonical_daily_budget;

DROP TRIGGER IF EXISTS transaction_audit_daily_budget;

DROP TRIGGER IF EXISTS insight_audit_daily_budget;

DROP TRIGGER IF EXISTS pat_canonical_daily_budget;

DROP TRIGGER IF EXISTS recurring_shared_pat_budget;

DROP TRIGGER IF EXISTS ingestion_publication_audit_budget;

DROP TRIGGER IF EXISTS pat_batch_envelope_daily_budget;

DROP TRIGGER IF EXISTS transaction_manual_daily_budget;

DROP TABLE transaction_audit;

DROP TABLE category_audit;

DROP TABLE memory_audit;

DROP TABLE budget_audit;

DROP TABLE dashboard_audit;

DROP TABLE email_replacement_audit;

CREATE INDEX session_audit_by_user_day ON session_audit(user_id,occurred_at_ms,id);

CREATE INDEX session_audit_retention ON session_audit(occurred_at_ms,id,user_id);

CREATE TRIGGER session_audit_no_update BEFORE UPDATE ON session_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE TRIGGER session_audit_no_delete BEFORE DELETE ON session_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='session_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE TRIGGER erasure_fence_session_audit_insert BEFORE INSERT ON session_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='session_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_session_audit_update BEFORE UPDATE ON session_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='session_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_session_audit_delete BEFORE DELETE ON session_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='session_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_session_audit_delete BEFORE DELETE ON session_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'session_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

-- Child completion and capacity checks remain atomic; Audit storage is not a quota.

CREATE TABLE canonical_child_guard_without_daily_budget (
  child_index INTEGER PRIMARY KEY NOT NULL CHECK (child_index BETWEEN 0 AND 11),
  operation TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  capacity_ok INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT canonical_child_guard_0 CHECK (child_index != 0 OR accepted = 1),
  CONSTRAINT canonical_child_guard_1 CHECK (child_index != 1 OR accepted = 1),
  CONSTRAINT canonical_child_guard_2 CHECK (child_index != 2 OR accepted = 1),
  CONSTRAINT canonical_child_guard_3 CHECK (child_index != 3 OR accepted = 1),
  CONSTRAINT canonical_child_guard_4 CHECK (child_index != 4 OR accepted = 1),
  CONSTRAINT canonical_child_guard_5 CHECK (child_index != 5 OR accepted = 1),
  CONSTRAINT canonical_child_guard_6 CHECK (child_index != 6 OR accepted = 1),
  CONSTRAINT canonical_child_guard_7 CHECK (child_index != 7 OR accepted = 1),
  CONSTRAINT canonical_child_guard_8 CHECK (child_index != 8 OR accepted = 1),
  CONSTRAINT canonical_child_guard_9 CHECK (child_index != 9 OR accepted = 1),
  CONSTRAINT canonical_child_guard_10 CHECK (child_index != 10 OR accepted = 1),
  CONSTRAINT canonical_child_guard_11 CHECK (child_index != 11 OR accepted = 1),
  CONSTRAINT canonical_child_capacity_0 CHECK (child_index != 0 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_1 CHECK (child_index != 1 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_2 CHECK (child_index != 2 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_3 CHECK (child_index != 3 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_4 CHECK (child_index != 4 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_5 CHECK (child_index != 5 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_6 CHECK (child_index != 6 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_7 CHECK (child_index != 7 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_8 CHECK (child_index != 8 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_9 CHECK (child_index != 9 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_10 CHECK (child_index != 10 OR capacity_ok = 1),
  CONSTRAINT canonical_child_capacity_11 CHECK (child_index != 11 OR capacity_ok = 1)
) STRICT;

INSERT INTO canonical_child_guard_without_daily_budget(child_index,operation,accepted,capacity_ok) SELECT child_index,operation,accepted,capacity_ok FROM canonical_child_guard;

DROP TABLE canonical_child_guard;

ALTER TABLE canonical_child_guard_without_daily_budget RENAME TO canonical_child_guard;
