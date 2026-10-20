PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS oauth_refresh_events_no_update;

DROP TRIGGER IF EXISTS oauth_refresh_events_no_delete;

DROP TRIGGER IF EXISTS erasure_fence_oauth_access_credentials_insert;

DROP TRIGGER IF EXISTS erasure_fence_oauth_access_credentials_update;

DROP TRIGGER IF EXISTS erasure_fence_oauth_access_credentials_delete;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_credentials_insert;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_credentials_update;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_credentials_delete;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_events_insert;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_events_update;

DROP TRIGGER IF EXISTS erasure_fence_oauth_refresh_events_delete;

DROP TRIGGER IF EXISTS audit_entries_no_delete;

DROP TRIGGER IF EXISTS audit_entries_no_update;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_session_call;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_insight_call;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_publication;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_media_admission;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_request_admission;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_identity_read;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_security_mutation;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_insert;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_update;

DROP TRIGGER IF EXISTS erasure_fence_audit_entries_delete;

DROP TRIGGER IF EXISTS erasure_preserve_audit_entries_billing_transition;

DROP TRIGGER IF EXISTS oauth_refresh_subject;

CREATE TABLE oauth_credentials (
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
 user_id TEXT REFERENCES users(id),digest BLOB NOT NULL CHECK(length(digest)=32),issued_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>issued_at_ms),consumed_at_ms INTEGER,
 scopes_json TEXT NOT NULL DEFAULT '["read"]',
 access_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='access' THEN id END) VIRTUAL UNIQUE,
 refresh_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='refresh' THEN id END) VIRTUAL UNIQUE,
 PRIMARY KEY(kind,id),UNIQUE(kind,digest),CHECK(kind='refresh' OR(user_id IS NOT NULL AND consumed_at_ms IS NULL))
) STRICT;

INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) SELECT 'access',id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json FROM oauth_access_credentials;

INSERT INTO oauth_credentials(kind,id,connection_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,user_id,scopes_json) SELECT 'refresh',id,connection_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,user_id,scopes_json FROM oauth_refresh_credentials;

CREATE TABLE audit_entries_consolidated (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 record_type TEXT NOT NULL,
 id TEXT,
 user_id TEXT,
 session_id TEXT,
 operation TEXT,
 outcome TEXT,
 occurred_at_ms INTEGER,
 pat_id TEXT,
 oauth_connection_id TEXT,
 oauth_credential_id TEXT,
 hosted_turn_id TEXT,
 attempt_id TEXT,
 transition TEXT,
 accepted_at_ms INTEGER,
 credential_session_id TEXT GENERATED ALWAYS AS (CASE WHEN record_type='session_call' AND operation GLOB 'dashboard.*' THEN NULL ELSE session_id END) VIRTUAL REFERENCES web_sessions(id),
 media_submission_id TEXT GENERATED ALWAYS AS (CASE WHEN record_type='media_admission' THEN id END) VIRTUAL REFERENCES media_submissions(id) ON DELETE CASCADE,
 UNIQUE(record_type,id), UNIQUE(attempt_id,transition),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(pat_id) REFERENCES pats(id),
 FOREIGN KEY(oauth_connection_id) REFERENCES oauth_connections(id),
 FOREIGN KEY(oauth_credential_id) REFERENCES oauth_credentials(access_id),
 FOREIGN KEY(hosted_turn_id) REFERENCES hosted_turns(id),
 FOREIGN KEY(attempt_id) REFERENCES billing_attempts(id),
 CHECK(
  (record_type='session_call' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND ((operation IN ('transactions.createTransaction','transactions.listTransactions','transactions.getTransaction','transactions.updateTransaction','transactions.deleteTransaction','transactions.searchTransactions','transactions.linkTransactions','transactions.unlinkTransactions','operations.executeAtomicBatch') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('categories.listCategories','categories.listKeywordRules','categories.createKeywordRule','categories.updateKeywordRule','categories.deleteKeywordRule') AND outcome IN ('success','validation_failed'))
 OR (operation IN ('memory.remember','memory.recall','memory.revise','memory.forget') AND outcome IN ('success','not_found','validation_failed','resource_limit'))
 OR (operation IN ('budgets.createBudget','budgets.updateBudget','budgets.deleteBudget','budgets.listBudgets','budgets.getBudget','budgets.getBudgetStatus') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('dashboard.getDashboard','dashboard.getDashboardView','dashboard.listDashboardCatalog','dashboard.applyDashboardEdit','dashboard.initializeDashboard') AND outcome IN ('accepted','rejected'))
 OR (operation IN ('emailAuthentication.requestEmailReplacement','emailAuthentication.completeEmailReplacement') AND outcome IN ('accepted','rejected','replaced'))) AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='credential_call' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (outcome IN ('accepted','rejected')) AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='insight_call' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation IN ('insights.listPendingInsights',
    'insights.markInsightDelivered', 'insights.markInsightRead', 'insights.dismissInsight',
    'insights.getReminderSchedule', 'insights.updateReminderSchedule', 'insights.getRecurringDigestReport')) AND (outcome IN ('accepted', 'rejected')) AND ((session_id IS NOT NULL) <> (hosted_turn_id IS NOT NULL)) AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='publication' AND id IS NOT NULL AND user_id IS NOT NULL AND operation IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation IN ('ingestion.submitForExtraction','ingestion.getStatementSubmission',
    'ingestion.enableEmailForwarding','ingestion.getEmailForwarding','ingestion.listNeedsReviewItems',
    'ingestion.resolveNeedsReviewItem','ingestion.skipNeedsReviewItem','ingestion.abandonStatementSubmission')) AND (outcome IN ('success','not_found','validation_failed','resource_limit')) AND (occurred_at_ms >= 0) AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='media_admission' AND user_id IS NOT NULL AND outcome IS NOT NULL AND occurred_at_ms IS NOT NULL AND (outcome = 'accepted') AND session_id IS NULL AND operation IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='billing_transition' AND attempt_id IS NOT NULL AND transition IS NOT NULL AND occurred_at_ms IS NOT NULL AND (transition IN ('succeeded', 'failed')) AND id IS NULL AND user_id IS NULL AND session_id IS NULL AND operation IS NULL AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='request_admission' AND id IS NOT NULL AND user_id IS NOT NULL AND pat_id IS NOT NULL AND operation IS NOT NULL AND accepted_at_ms IS NOT NULL AND session_id IS NULL AND outcome IS NULL AND occurred_at_ms IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL) OR
  (record_type='identity_read' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND occurred_at_ms IS NOT NULL AND operation IS NULL AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type='security_mutation' AND id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND operation IS NOT NULL AND occurred_at_ms IS NOT NULL AND (operation = 'recovery.rotateBackupRecoveryCode') AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL)
 )
) STRICT;

INSERT INTO audit_entries_consolidated("sequence","record_type","id","user_id","session_id","operation","outcome","occurred_at_ms","pat_id","oauth_connection_id","oauth_credential_id","hosted_turn_id","attempt_id","transition","accepted_at_ms") SELECT "sequence","record_type","id","user_id","session_id","operation","outcome","occurred_at_ms","pat_id","oauth_connection_id","oauth_credential_id","hosted_turn_id","attempt_id","transition","accepted_at_ms" FROM audit_entries;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='audit_entries_consolidated';

INSERT INTO sqlite_sequence(name,seq) SELECT 'audit_entries_consolidated',seq FROM sqlite_sequence WHERE name='audit_entries' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='audit_entries_consolidated');

DROP TABLE audit_entries;

ALTER TABLE audit_entries_consolidated RENAME TO audit_entries;

CREATE INDEX audit_entries_user ON audit_entries(user_id,record_type,occurred_at_ms,id);

CREATE INDEX audit_entries_history ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call');

CREATE INDEX audit_entries_user_retention ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call','publication');

CREATE INDEX audit_entries_retention ON audit_entries(occurred_at_ms,id,user_id) WHERE record_type IN('session_call','credential_call','insight_call','publication');

CREATE INDEX audit_entries_pat_activity ON audit_entries(user_id,pat_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';

CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';

CREATE INDEX audit_entries_admission_expiry ON audit_entries(accepted_at_ms) WHERE record_type='request_admission';

CREATE INDEX audit_entries_media ON audit_entries(media_submission_id);

CREATE TABLE oauth_refresh_events_consolidated (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  consumed_credential_id TEXT NOT NULL UNIQUE REFERENCES oauth_credentials(refresh_id),
  issued_credential_id TEXT NOT NULL UNIQUE REFERENCES oauth_credentials(refresh_id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO oauth_refresh_events_consolidated("id","user_id","connection_id","consumed_credential_id","issued_credential_id","occurred_at_ms") SELECT "id","user_id","connection_id","consumed_credential_id","issued_credential_id","occurred_at_ms" FROM oauth_refresh_events;

DROP TABLE oauth_refresh_events;

ALTER TABLE oauth_refresh_events_consolidated RENAME TO oauth_refresh_events;

DROP TABLE oauth_access_credentials;

DROP TABLE oauth_refresh_credentials;

CREATE TRIGGER oauth_refresh_events_no_update BEFORE UPDATE ON oauth_refresh_events
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;

CREATE TRIGGER oauth_refresh_events_no_delete BEFORE DELETE ON oauth_refresh_events
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_refresh_events' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;

CREATE TRIGGER erasure_fence_oauth_access_credentials_insert BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_access_credentials_update BEFORE UPDATE ON oauth_credentials
WHEN NEW.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_access_credentials_delete BEFORE DELETE ON oauth_credentials
WHEN OLD.kind='access' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_insert BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='refresh' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_update BEFORE UPDATE ON oauth_credentials
WHEN NEW.kind='refresh' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_credentials_delete BEFORE DELETE ON oauth_credentials
WHEN OLD.kind='refresh' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_credentials'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_events_insert BEFORE INSERT ON oauth_refresh_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_refresh_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_events_update BEFORE UPDATE ON oauth_refresh_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_refresh_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_oauth_refresh_events_delete BEFORE DELETE ON oauth_refresh_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='oauth_refresh_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
WHEN OLD.record_type IN ('session_call','credential_call','insight_call','publication')
 AND NOT EXISTS (
  SELECT 1 FROM audit_retention_permits WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms
 )
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
  WHERE p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id
  AND p.store_id=CASE OLD.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;

CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;

CREATE TRIGGER erasure_preserve_audit_entries_session_call BEFORE DELETE ON audit_entries
WHEN OLD.record_type='session_call' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'session_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_insight_call BEFORE DELETE ON audit_entries
WHEN OLD.record_type='insight_call' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'hosted_turn_id',OLD."hosted_turn_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_publication BEFORE DELETE ON audit_entries
WHEN OLD.record_type='publication' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'ingestion_publication_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'operation',OLD."operation",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_media_admission BEFORE DELETE ON audit_entries
WHEN OLD.record_type='media_admission' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submission_audit','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'outcome',OLD."outcome",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_request_admission BEFORE DELETE ON audit_entries
WHEN OLD.record_type='request_admission' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_acceptances','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'operation',OLD."operation",'accepted_at_ms',OLD."accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_identity_read BEFORE DELETE ON audit_entries
WHEN OLD.record_type='identity_read' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_user_reads','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_audit_entries_security_mutation BEFORE DELETE ON audit_entries
WHEN OLD.record_type='security_mutation' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_security_mutations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_fence_audit_entries_insert BEFORE INSERT ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_audit_entries_update BEFORE UPDATE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND (COALESCE(NEW.user_id,(SELECT user_id FROM billing_attempts WHERE id=NEW.attempt_id))=q.user_id OR COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id)
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE NEW.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_fence_audit_entries_delete BEFORE DELETE ON audit_entries
WHEN EXISTS (
 SELECT 1 FROM erasure_requests q
 WHERE q.state NOT IN ('AwaitingReview','Draining') AND COALESCE(OLD.user_id,(SELECT user_id FROM billing_attempts WHERE id=OLD.attempt_id))=q.user_id
 AND NOT EXISTS (
  SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id
  AND p.store_id=CASE OLD.record_type
 WHEN 'session_call' THEN 'session_audit'
 WHEN 'credential_call' THEN 'pat_audit'
 WHEN 'insight_call' THEN 'insight_audit'
 WHEN 'publication' THEN 'ingestion_publication_audit'
 WHEN 'media_admission' THEN 'media_submission_audit'
 WHEN 'billing_transition' THEN 'billing_audit'
 WHEN 'request_admission' THEN 'canonical_request_acceptances'
 WHEN 'identity_read' THEN 'canonical_user_reads'
 WHEN 'security_mutation' THEN 'canonical_security_mutations'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER erasure_preserve_audit_entries_billing_transition BEFORE DELETE ON audit_entries
WHEN OLD.record_type='billing_transition' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_audit','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'transition',OLD."transition",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER oauth_refresh_subject BEFORE INSERT ON oauth_credentials
WHEN NEW.kind='refresh' AND (NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM oauth_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id)
) BEGIN
 SELECT RAISE(ABORT,'oauth_subject');
END;

CREATE TRIGGER oauth_credential_kind_immutable BEFORE UPDATE OF kind ON oauth_credentials WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'oauth_credential_kind_immutable'); END;

CREATE INDEX oauth_credentials_owner ON oauth_credentials(user_id,kind,expires_at_ms);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_oauth_credentials',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_oauth_credentials';

PRAGMA defer_foreign_keys=OFF;
