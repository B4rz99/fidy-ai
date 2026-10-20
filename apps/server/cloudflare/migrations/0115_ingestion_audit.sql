CREATE TABLE ingestion_publication_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK (operation IN ('ingestion.submitForExtraction','ingestion.getStatementSubmission',
    'ingestion.enableEmailForwarding','ingestion.getEmailForwarding','ingestion.listNeedsReviewItems',
    'ingestion.resolveNeedsReviewItem','ingestion.skipNeedsReviewItem','ingestion.abandonStatementSubmission')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','not_found','validation_failed','resource_limit')),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0)
) STRICT;

CREATE INDEX ingestion_publication_audit_by_user_day ON ingestion_publication_audit(user_id,occurred_at_ms);

CREATE INDEX ingestion_publication_audit_retention ON ingestion_publication_audit(occurred_at_ms,id,user_id);

INSERT INTO ingestion_publication_audit SELECT * FROM statement_submission_audit;

INSERT INTO ingestion_publication_audit SELECT * FROM statement_review_audit;

INSERT INTO ingestion_publication_audit SELECT * FROM statement_clarification_audit;

DROP TRIGGER IF EXISTS statement_submission_audit_no_update;

DROP TRIGGER IF EXISTS statement_review_audit_no_update;

DROP TRIGGER IF EXISTS statement_audit_daily_budget;

DROP TRIGGER IF EXISTS category_canonical_daily_budget;

DROP TRIGGER IF EXISTS memory_canonical_daily_budget;

DROP TRIGGER IF EXISTS statement_review_audit_daily_budget;

DROP TRIGGER IF EXISTS recurring_shared_statement_budget;

DROP TRIGGER IF EXISTS recurring_shared_review_budget;

DROP TRIGGER IF EXISTS statement_clarification_audit_no_update;

DROP TRIGGER IF EXISTS statement_clarification_audit_budget;

DROP TRIGGER IF EXISTS transaction_audit_daily_budget;

DROP TRIGGER IF EXISTS recurring_shared_transaction_budget;

DROP TRIGGER IF EXISTS recurring_shared_category_budget;

DROP TRIGGER IF EXISTS recurring_shared_memory_budget;

DROP TRIGGER IF EXISTS statement_submission_audit_no_delete;

DROP TRIGGER IF EXISTS statement_review_audit_no_delete;

DROP TRIGGER IF EXISTS statement_clarification_audit_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_statement_clarification_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_clarification_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_clarification_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_audit_delete;

DROP TRIGGER IF EXISTS erasure_fence_statement_submission_audit_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_submission_audit_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_submission_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_clarification_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_review_audit_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_submission_audit_delete;

DROP VIEW IF EXISTS canonical_audit_usage;

DROP TABLE statement_submission_audit;

DROP TABLE statement_review_audit;

DROP TABLE statement_clarification_audit;

CREATE VIEW canonical_audit_usage AS
SELECT * FROM (
SELECT user_id, occurred_at_ms FROM transaction_audit WHERE operation != 'operations.executeAtomicBatch'
UNION ALL SELECT user_id, occurred_at_ms FROM pat_audit
  WHERE operation != 'operations.executeAtomicBatch'
  AND (((pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL))
    AND operation NOT LIKE 'pats.%') OR operation LIKE 'connections.%' OR operation LIKE 'recurringPlans.%' OR operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
UNION ALL SELECT user_id, occurred_at_ms FROM category_audit
UNION ALL SELECT user_id, occurred_at_ms FROM memory_audit)
UNION ALL SELECT user_id, occurred_at_ms FROM ingestion_publication_audit;

CREATE TRIGGER ingestion_publication_audit_no_update BEFORE UPDATE ON ingestion_publication_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE TRIGGER category_canonical_daily_budget BEFORE INSERT ON category_audit
WHEN (SELECT count(*) FROM canonical_audit_usage WHERE user_id=NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000)+1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

CREATE TRIGGER memory_canonical_daily_budget BEFORE INSERT ON memory_audit
WHEN (SELECT count(*) FROM canonical_audit_usage WHERE user_id=NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000)+1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

CREATE TRIGGER transaction_audit_daily_budget BEFORE INSERT ON transaction_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id=NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000)+1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

CREATE TRIGGER ingestion_publication_audit_no_delete BEFORE DELETE ON ingestion_publication_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='ingestion_publication_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE TRIGGER erasure_fence_ingestion_publication_audit_insert BEFORE INSERT ON ingestion_publication_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_publication_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_publication_audit_update BEFORE UPDATE ON ingestion_publication_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_publication_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_publication_audit_delete BEFORE DELETE ON ingestion_publication_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_publication_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_ingestion_publication_audit_delete BEFORE DELETE ON ingestion_publication_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'ingestion_publication_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER ingestion_publication_audit_budget BEFORE INSERT ON ingestion_publication_audit
WHEN (SELECT count(*) FROM canonical_audit_usage WHERE user_id=NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000)+1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'statement_audit_limit'); END;
