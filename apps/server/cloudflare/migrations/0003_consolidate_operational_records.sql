-- Preserve independent erasure, restore and security policies while sharing their storage.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP TABLE support_recovery_operator_limits;
--> statement-breakpoint

CREATE TABLE erasure_control (
 kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('published','restore','email','statement','erasure')),
 generation TEXT,
 cursor TEXT,
 scanned INTEGER CHECK(scanned IN (0,1)),
 CHECK((kind='published' AND generation IS NOT NULL AND cursor IS NULL AND scanned IS NULL)
 OR (kind='restore' AND generation IS NOT NULL AND cursor IS NOT NULL AND scanned IS NOT NULL)
 OR (kind IN ('email','statement','erasure') AND generation IS NULL AND cursor IS NOT NULL AND scanned IS NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO erasure_control(kind,generation) SELECT 'published',generation FROM erasure_generation;
--> statement-breakpoint

INSERT INTO erasure_control(kind,generation,cursor,scanned) SELECT 'restore',generation,cursor,scanned FROM erasure_restore_sessions;
--> statement-breakpoint

INSERT INTO erasure_control(kind,cursor) SELECT bucket,cursor FROM erasure_control_sweeps;
--> statement-breakpoint

DROP TABLE erasure_generation;
--> statement-breakpoint

DROP TABLE erasure_restore_sessions;
--> statement-breakpoint

DROP TABLE erasure_control_sweeps;
--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_pairing_email_user_limits_delete;
--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_pairing_email_user_limits_insert;
--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_pairing_email_user_limits_update;
--> statement-breakpoint

DROP TRIGGER erasure_fence_email_replacement_limits_delete;
--> statement-breakpoint

DROP TRIGGER erasure_fence_email_replacement_limits_insert;
--> statement-breakpoint

DROP TRIGGER erasure_fence_email_replacement_limits_update;
--> statement-breakpoint

CREATE TABLE _email_security_limits (
 kind TEXT NOT NULL CHECK(kind IN ('pairing','replacement','pairing-global')),
 user_id TEXT REFERENCES users(id),
 window_started_at_ms INTEGER NOT NULL,
 requests INTEGER NOT NULL CHECK(requests>=1 AND requests<=CASE WHEN kind='pairing-global' THEN 1000 ELSE 5 END),
 last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),
 CHECK((kind='pairing-global' AND user_id IS NULL AND last_work_id IS NULL)
 OR (kind='pairing' AND user_id IS NOT NULL AND last_work_id IS NULL)
 OR (kind='replacement' AND user_id IS NOT NULL AND last_work_id IS NOT NULL)),
 UNIQUE(kind,user_id)
) STRICT;
--> statement-breakpoint

INSERT INTO _email_security_limits SELECT * FROM email_security_limits;
--> statement-breakpoint

INSERT INTO _email_security_limits SELECT 'pairing-global',NULL,window_started_at_ms,requests,NULL FROM browser_pairing_email_global_limit;
--> statement-breakpoint

DROP TABLE email_security_limits;
--> statement-breakpoint

ALTER TABLE _email_security_limits RENAME TO email_security_limits;
--> statement-breakpoint

CREATE UNIQUE INDEX email_security_global_identity ON email_security_limits(kind) WHERE kind='pairing-global';
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_delete BEFORE DELETE ON email_security_limits WHEN (OLD.kind='pairing') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_insert BEFORE INSERT ON email_security_limits WHEN (NEW.kind='pairing') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_update BEFORE UPDATE ON email_security_limits WHEN ((NEW.user_id IS NOT OLD.user_id OR NEW.requests IS NOT OLD.requests OR NEW.window_started_at_ms IS NOT OLD.window_started_at_ms OR NEW.kind IS NOT OLD.kind) AND (OLD.kind='pairing' OR NEW.kind='pairing')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_delete BEFORE DELETE ON email_security_limits WHEN (OLD.kind='replacement') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_insert BEFORE INSERT ON email_security_limits WHEN (NEW.kind='replacement') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_email_replacement_limits_update BEFORE UPDATE ON email_security_limits WHEN ((NEW.user_id IS NOT OLD.user_id OR NEW.last_work_id IS NOT OLD.last_work_id OR NEW.requests IS NOT OLD.requests OR NEW.window_started_at_ms IS NOT OLD.window_started_at_ms OR NEW.kind IS NOT OLD.kind) AND (OLD.kind='replacement' OR NEW.kind='replacement')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='email_replacement_limits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TABLE browser_pairing_email_global_limit;
--> statement-breakpoint

DROP INDEX "audit_entries_admission_expiry";
--> statement-breakpoint

DROP INDEX "audit_entries_history";
--> statement-breakpoint

DROP INDEX "audit_entries_media";
--> statement-breakpoint

DROP INDEX "audit_entries_oauth_activity";
--> statement-breakpoint

DROP INDEX "audit_entries_pat_activity";
--> statement-breakpoint

DROP INDEX "audit_entries_recovery_case";
--> statement-breakpoint

DROP INDEX "audit_entries_refresh_connection";
--> statement-breakpoint

DROP INDEX "audit_entries_retention";
--> statement-breakpoint

DROP INDEX "audit_entries_user";
--> statement-breakpoint

DROP INDEX "audit_entries_user_retention";
--> statement-breakpoint

DROP TRIGGER "audit_entries_no_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_audit_entries_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_billing_transition";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_identity_read";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_insight_call";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_media_admission";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_publication";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_request_admission";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_security_mutation";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_session_call";
--> statement-breakpoint

DROP TRIGGER "oauth_refresh_events_no_delete";
--> statement-breakpoint

DROP TRIGGER "audit_entries_no_delete";
--> statement-breakpoint

CREATE TABLE _audit_entries (
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
 refresh_connection_id TEXT REFERENCES oauth_connections(id),
 consumed_refresh_id TEXT UNIQUE REFERENCES oauth_credentials(refresh_id),
 issued_refresh_id TEXT UNIQUE REFERENCES oauth_credentials(refresh_id),
 recovery_case_id TEXT REFERENCES support_recovery_cases(id),
 operator_issuer TEXT,
 operator_subject TEXT,
 recovery_action TEXT CHECK(recovery_action IS NULL OR recovery_action IN ('opened','approved','rejected')),
 CHECK((record_type='oauth_refresh' AND refresh_connection_id IS NOT NULL AND consumed_refresh_id IS NOT NULL AND issued_refresh_id IS NOT NULL) OR (record_type<>'oauth_refresh' AND refresh_connection_id IS NULL AND consumed_refresh_id IS NULL AND issued_refresh_id IS NULL)),
 CHECK((record_type='support_recovery' AND recovery_case_id IS NOT NULL AND operator_issuer IS NOT NULL AND operator_subject IS NOT NULL AND recovery_action IS NOT NULL) OR (record_type<>'support_recovery' AND recovery_case_id IS NULL AND operator_issuer IS NULL AND operator_subject IS NULL AND recovery_action IS NULL)),
 UNIQUE(record_type,id), UNIQUE(attempt_id,transition),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(pat_id) REFERENCES pats(id),
 FOREIGN KEY(oauth_connection_id) REFERENCES oauth_connections(id),
 FOREIGN KEY(oauth_credential_id) REFERENCES oauth_credentials(access_id),
 FOREIGN KEY(hosted_turn_id) REFERENCES hosted_turns(id),
 FOREIGN KEY(attempt_id) REFERENCES billing_attempts(id),
 CHECK(
  (record_type='reminder_control' AND id IS NOT NULL AND json_valid(id) AND json_array_length(id)=2 AND json_extract(id,'$[0]')=user_id AND json_type(id,'$[1]')='text' AND user_id IS NOT NULL AND outcome IS NOT NULL AND session_id IS NULL AND operation IS NULL AND occurred_at_ms IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
  (record_type IN ('oauth_refresh','support_recovery') AND id IS NOT NULL AND user_id IS NOT NULL AND occurred_at_ms IS NOT NULL AND session_id IS NULL AND operation IS NULL AND outcome IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL AND hosted_turn_id IS NULL AND attempt_id IS NULL AND transition IS NULL AND accepted_at_ms IS NULL) OR
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
--> statement-breakpoint

INSERT INTO _audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id,recovery_case_id,operator_issuer,operator_subject,recovery_action) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id,recovery_case_id,operator_issuer,operator_subject,recovery_action FROM audit_entries;
--> statement-breakpoint

INSERT INTO _audit_entries(record_type,id,user_id,outcome) SELECT 'reminder_control',json_array(user_id,message_id),user_id,choice FROM reminder_control_receipts;
--> statement-breakpoint

DROP TABLE audit_entries;
--> statement-breakpoint

ALTER TABLE _audit_entries RENAME TO audit_entries;
--> statement-breakpoint

CREATE INDEX audit_entries_admission_expiry ON audit_entries(accepted_at_ms) WHERE record_type='request_admission';
--> statement-breakpoint

CREATE INDEX audit_entries_history ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call');
--> statement-breakpoint

CREATE INDEX audit_entries_media ON audit_entries(media_submission_id);
--> statement-breakpoint

CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';
--> statement-breakpoint

CREATE INDEX audit_entries_pat_activity ON audit_entries(user_id,pat_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call';
--> statement-breakpoint

CREATE INDEX audit_entries_recovery_case ON audit_entries(recovery_case_id,occurred_at_ms) WHERE record_type='support_recovery';
--> statement-breakpoint

CREATE INDEX audit_entries_refresh_connection ON audit_entries(refresh_connection_id) WHERE refresh_connection_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX audit_entries_retention ON audit_entries(occurred_at_ms,id,user_id) WHERE record_type IN('session_call','credential_call','insight_call','publication');
--> statement-breakpoint

CREATE INDEX audit_entries_user ON audit_entries(user_id,record_type,occurred_at_ms,id);
--> statement-breakpoint

CREATE INDEX audit_entries_user_retention ON audit_entries(user_id,occurred_at_ms,id) WHERE record_type IN('session_call','credential_call','insight_call','publication');
--> statement-breakpoint

CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
--> statement-breakpoint

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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

CREATE TRIGGER oauth_refresh_events_no_delete BEFORE DELETE ON audit_entries
WHEN OLD.record_type='oauth_refresh' AND (NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_refresh_events' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
WHEN OLD.record_type IN ('session_call','credential_call','insight_call','publication')
 AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS user_id,audit_retention_cutoff_ms AS cutoff_ms FROM users WHERE audit_retention_cutoff_ms IS NOT NULL) WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms
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
 WHEN 'oauth_refresh' THEN 'oauth_refresh_events'
 WHEN 'support_recovery' THEN 'support_recovery_events'
 WHEN 'reminder_control' THEN 'reminder_control_receipts'
 END
 )
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_reminder_control BEFORE DELETE ON audit_entries
WHEN OLD.record_type='reminder_control' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_control_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'message_id',json_extract(OLD.id,'$[1]'),'choice',OLD.outcome)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TABLE reminder_control_receipts;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP INDEX "insight_reports_proactivity_identity";
--> statement-breakpoint

DROP INDEX "insight_reports_recurring_day";
--> statement-breakpoint

DROP INDEX "insight_reports_text_expiry";
--> statement-breakpoint

DROP INDEX "proactivity_offer_requests_due";
--> statement-breakpoint

DROP INDEX "recurring_current_opportunity";
--> statement-breakpoint

DROP INDEX "report_dispatch_due";
--> statement-breakpoint

DROP INDEX "report_dispatch_health";
--> statement-breakpoint

DROP INDEX "weekly_question_intents_due";
--> statement-breakpoint

DROP INDEX "weekly_question_intents_expiry";
--> statement-breakpoint

DROP INDEX "weekly_question_intents_health";
--> statement-breakpoint

DROP INDEX "weekly_question_request";
--> statement-breakpoint

DROP VIEW "proactivity_delivery_metadata";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_reports_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_reports_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_insight_reports_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_offer_requests_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_offer_requests_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_proactivity_offer_requests_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_weekly_question_intents_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_weekly_question_intents_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_weekly_question_intents_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_insight_reports_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactivity_offer_requests_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_weekly_question_intents_delete";
--> statement-breakpoint

DROP TRIGGER "insight_reports_immutable";
--> statement-breakpoint

DROP TRIGGER "insight_reports_no_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_erasure_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_erasure_insert";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_erasure_update";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_preserve_update";
--> statement-breakpoint

CREATE TABLE _insight_reports (
 kind TEXT NOT NULL CHECK(kind IN ('weekly-summary','proactivity-delivery','weekly-question','offer-request')),
 user_id TEXT NOT NULL REFERENCES users(id),
 delivery_id TEXT NOT NULL,
 origin TEXT CHECK(origin IN ('proactive','requested')),
 request_message_id TEXT,
 rejection_offer_id TEXT,
 request_kind TEXT CHECK(request_kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')),
 materialized_at_ms INTEGER,
 last_evaluated_at_ms INTEGER,
 offer_delivery_id TEXT,
 current_recurring_opportunity INTEGER CHECK(current_recurring_opportunity IS NULL OR(current_recurring_opportunity=1 AND kind='offer-request' AND request_kind='new-recurring-series')),
 role TEXT CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT,
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER,
 expires_at_ms INTEGER,
 time_zone TEXT,
 created_at_ms INTEGER,
 payload_json TEXT CHECK(json_valid(payload_json)),
 presentation_json TEXT CHECK(json_valid(presentation_json)),
 reminder_grant_id TEXT,
 reminder_expires_at_ms INTEGER,
 instruction_id TEXT,
 instruction_version INTEGER,
 grant_id TEXT,
 local_date TEXT,
 day_from_ms INTEGER,
 day_to_ms INTEGER,
 report_json TEXT CHECK(json_valid(report_json)),
 event_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='weekly-summary' OR reminder_grant_id IS NOT NULL OR report_json IS NOT NULL THEN delivery_id END) VIRTUAL,
 dispatch_reference TEXT GENERATED ALWAYS AS (CASE WHEN scheduled_at_ms IS NOT NULL OR kind='weekly-question' THEN delivery_id END) VIRTUAL,
 proactivity_reference TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL THEN delivery_id END) VIRTUAL,
 grant_history_type TEXT GENERATED ALWAYS AS (CASE WHEN kind='proactivity-delivery' THEN 'proactivity_grant' END) VIRTUAL,
 reminder_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL, dispatch_state TEXT, dispatch_created_at_ms INTEGER, dispatch_last_attempt_at_ms INTEGER, dispatch_restart_attempts INTEGER CHECK((dispatch_state IS NULL AND dispatch_created_at_ms IS NULL AND dispatch_last_attempt_at_ms IS NULL AND dispatch_restart_attempts IS NULL) OR (dispatch_state IS NOT NULL AND (dispatch_state IN ('ready','started','settled','expired','refused')) AND dispatch_created_at_ms IS NOT NULL AND dispatch_last_attempt_at_ms IS NOT NULL AND dispatch_restart_attempts IS NOT NULL AND (dispatch_restart_attempts BETWEEN 0 AND 3))) CHECK(dispatch_state IS NULL OR dispatch_reference IS NOT NULL),
 PRIMARY KEY(user_id,kind,delivery_id),
 UNIQUE(user_id,kind,dispatch_reference),
 UNIQUE(user_id,proactivity_reference),
 FOREIGN KEY(user_id,event_reference) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(user_id,grant_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY(user_id,reminder_history_type,reminder_grant_id) REFERENCES consent_history(user_id,record_type,id),
 CHECK((reminder_grant_id IS NULL)=(reminder_expires_at_ms IS NULL)),
 CHECK((report_json IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL)
  OR (report_json IS NOT NULL AND instruction_id IS NOT NULL AND instruction_version IS NOT NULL AND grant_id IS NOT NULL AND local_date IS NOT NULL AND day_from_ms IS NOT NULL AND day_to_ms IS NOT NULL AND day_to_ms>day_from_ms)),
 CHECK(((kind='weekly-summary' AND consent_grant_id IS NOT NULL AND payload_json IS NOT NULL AND presentation_json IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND expires_at_ms>scheduled_at_ms AND expires_at_ms<=scheduled_at_ms+86400000 AND role IS NULL AND offer_id IS NULL AND text IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND reminder_grant_id IS NULL AND report_json IS NULL)
  OR (kind='proactivity-delivery' AND payload_json IS NULL AND presentation_json IS NULL AND
   ((scheduled_at_ms IS NOT NULL AND role IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND created_at_ms IS NOT NULL AND
    ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL)))
   OR (scheduled_at_ms IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND created_at_ms IS NULL AND (reminder_grant_id IS NOT NULL OR report_json IS NOT NULL)))))
 OR (kind='weekly-question' AND dispatch_state IS NOT NULL AND origin IS NOT NULL AND created_at_ms IS NOT NULL AND dispatch_state IN ('ready','settled','expired','refused') AND dispatch_created_at_ms=created_at_ms AND request_kind IS NULL AND materialized_at_ms IS NULL AND last_evaluated_at_ms IS NULL AND offer_delivery_id IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND scheduled_at_ms IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND payload_json IS NULL AND presentation_json IS NULL AND reminder_grant_id IS NULL AND reminder_expires_at_ms IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND report_json IS NULL)
 OR (kind='offer-request' AND request_kind IS NOT NULL AND request_message_id IS NOT NULL AND created_at_ms IS NOT NULL AND last_evaluated_at_ms IS NOT NULL AND origin IS NULL AND rejection_offer_id IS NULL AND dispatch_state IS NULL AND role IS NULL AND consent_grant_id IS NULL AND offer_id IS NULL AND text IS NULL AND scheduled_at_ms IS NULL AND expires_at_ms IS NULL AND time_zone IS NULL AND payload_json IS NULL AND presentation_json IS NULL AND reminder_grant_id IS NULL AND reminder_expires_at_ms IS NULL AND instruction_id IS NULL AND instruction_version IS NULL AND grant_id IS NULL AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND report_json IS NULL)),
 CHECK(kind NOT IN ('weekly-summary','proactivity-delivery') OR (origin IS NULL AND request_message_id IS NULL AND rejection_offer_id IS NULL AND request_kind IS NULL AND materialized_at_ms IS NULL AND last_evaluated_at_ms IS NULL AND offer_delivery_id IS NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO _insight_reports(kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,payload_json,presentation_json,reminder_grant_id,reminder_expires_at_ms,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) SELECT kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,payload_json,presentation_json,reminder_grant_id,reminder_expires_at_ms,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts FROM insight_reports;
--> statement-breakpoint

INSERT INTO _insight_reports(kind,user_id,delivery_id,origin,request_message_id,rejection_offer_id,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) SELECT 'weekly-question',user_id,id,origin,request_message_id,rejection_offer_id,created_at_ms,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM weekly_question_intents;
--> statement-breakpoint

INSERT INTO _insight_reports(kind,user_id,delivery_id,request_kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_delivery_id,current_recurring_opportunity) SELECT 'offer-request',user_id,id,kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,delivery_id,current_recurring_opportunity FROM proactivity_offer_requests;
--> statement-breakpoint

DROP TABLE insight_reports;
--> statement-breakpoint

DROP TABLE weekly_question_intents;
--> statement-breakpoint

DROP TABLE proactivity_offer_requests;
--> statement-breakpoint

ALTER TABLE _insight_reports RENAME TO insight_reports;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_reports_proactivity_identity ON insight_reports(delivery_id) WHERE kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX insight_reports_recurring_day ON insight_reports(user_id,local_date,day_from_ms,day_to_ms) WHERE report_json IS NOT NULL;
--> statement-breakpoint

CREATE INDEX insight_reports_text_expiry ON insight_reports(created_at_ms,user_id,delivery_id) WHERE kind='proactivity-delivery' AND text IS NOT NULL;
--> statement-breakpoint

CREATE INDEX proactivity_offer_requests_due ON insight_reports(materialized_at_ms,last_evaluated_at_ms,created_at_ms) WHERE kind='offer-request';
--> statement-breakpoint

CREATE UNIQUE INDEX recurring_current_opportunity ON insight_reports(user_id) WHERE current_recurring_opportunity=1 AND kind='offer-request';
--> statement-breakpoint

CREATE INDEX report_dispatch_due ON insight_reports(dispatch_state,dispatch_last_attempt_at_ms,dispatch_created_at_ms,kind,delivery_id,user_id) WHERE dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX report_dispatch_health ON insight_reports(kind,dispatch_created_at_ms,user_id,delivery_id)
 WHERE dispatch_state IN ('ready','started') AND dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE INDEX weekly_question_intents_due ON insight_reports(dispatch_state,dispatch_last_attempt_at_ms,created_at_ms) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_intents_expiry ON insight_reports(dispatch_state,created_at_ms) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE INDEX weekly_question_intents_health ON insight_reports(created_at_ms, user_id, delivery_id)
WHERE dispatch_state='ready' AND kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_request ON insight_reports(user_id,request_message_id) WHERE request_message_id IS NOT NULL AND kind='weekly-question';
--> statement-breakpoint

CREATE VIEW proactivity_delivery_metadata AS
 SELECT user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,
 dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts,CASE WHEN kind='weekly-question' THEN created_at_ms+86400000 ELSE expires_at_ms END AS expires_at_ms,
 (kind IN ('weekly-summary','weekly-question') OR text IS NOT NULL) AS content_available
 FROM insight_reports WHERE dispatch_state IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind IN ('weekly-summary','proactivity-delivery') OR NEW.kind IN ('weekly-summary','proactivity-delivery')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_proactivity_offer_requests_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')) AND NOT(NEW.delivery_id IS OLD.delivery_id AND NEW.user_id IS OLD.user_id AND NEW.request_kind IS OLD.request_kind AND NEW.request_message_id IS OLD.request_message_id AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.materialized_at_ms IS OLD.materialized_at_ms AND NEW.last_evaluated_at_ms IS OLD.last_evaluated_at_ms AND NEW.offer_delivery_id IS OLD.offer_delivery_id))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_insert BEFORE INSERT ON insight_reports
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_weekly_question_intents_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='weekly-question' OR NEW.kind='weekly-question') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_question_intents')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'insight_reports','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'delivery_id',OLD.delivery_id,'role',OLD.role,'consent_grant_id',OLD.consent_grant_id,'offer_id',OLD.offer_id,'text',OLD.text,'scheduled_at_ms',OLD.scheduled_at_ms,'expires_at_ms',OLD.expires_at_ms,'time_zone',OLD.time_zone,'created_at_ms',OLD.created_at_ms,'payload_json',OLD.payload_json,'presentation_json',OLD.presentation_json,'reminder_grant_id',OLD.reminder_grant_id,'reminder_expires_at_ms',OLD.reminder_expires_at_ms,'instruction_id',OLD.instruction_id,'instruction_version',OLD.instruction_version,'grant_id',OLD.grant_id,'local_date',OLD.local_date,'day_from_ms',OLD.day_from_ms,'day_to_ms',OLD.day_to_ms,'report_json',OLD.report_json,'dispatch_state',OLD.dispatch_state,'dispatch_created_at_ms',OLD.dispatch_created_at_ms,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'dispatch_restart_attempts',OLD.dispatch_restart_attempts) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_offer_requests_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_offer_requests','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'kind',OLD.request_kind,'request_message_id',OLD.request_message_id,'created_at_ms',OLD.created_at_ms,'materialized_at_ms',OLD.materialized_at_ms,'last_evaluated_at_ms',OLD.last_evaluated_at_ms,'delivery_id',OLD.offer_delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_question_intents_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_question_intents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'origin',OLD.origin,'request_message_id',OLD.request_message_id,'rejection_offer_id',OLD.rejection_offer_id,'state',OLD.dispatch_state,'created_at_ms',OLD.created_at_ms,'last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'restart_attempts',OLD.dispatch_restart_attempts)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER insight_reports_immutable BEFORE UPDATE ON insight_reports WHEN (OLD.kind IN ('weekly-summary','proactivity-delivery') OR NEW.kind IN ('weekly-summary','proactivity-delivery')) AND (NOT(NEW.kind IS OLD.kind AND NEW.user_id IS OLD.user_id AND NEW.delivery_id IS OLD.delivery_id AND NEW.role IS OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms IS OLD.scheduled_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.time_zone IS OLD.time_zone AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.payload_json IS OLD.payload_json AND NEW.presentation_json IS OLD.presentation_json AND NEW.reminder_grant_id IS OLD.reminder_grant_id AND NEW.reminder_expires_at_ms IS OLD.reminder_expires_at_ms AND NEW.instruction_id IS OLD.instruction_id AND NEW.instruction_version IS OLD.instruction_version AND NEW.grant_id IS OLD.grant_id AND NEW.local_date IS OLD.local_date AND NEW.day_from_ms IS OLD.day_from_ms AND NEW.day_to_ms IS OLD.day_to_ms AND NEW.report_json IS OLD.report_json AND (NEW.text IS OLD.text OR (OLD.kind='proactivity-delivery' AND OLD.text IS NOT NULL AND NEW.text IS NULL)))) BEGIN SELECT RAISE(ABORT,'insight_report_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER insight_reports_no_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='insight_reports' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN
 SELECT RAISE(ABORT,'insight_report_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_delete BEFORE DELETE ON insight_reports WHEN OLD.kind='offer-request' AND ((OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities')))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_insert BEFORE INSERT ON insight_reports WHEN NEW.kind='offer-request' AND ((NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities')))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_erasure_update BEFORE UPDATE ON insight_reports WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND ((NEW.current_recurring_opportunity IS NOT OLD.current_recurring_opportunity) AND ((OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))) OR (NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND (OLD.current_recurring_opportunity=1 AND NEW.current_recurring_opportunity IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER insight_work_identity_immutable BEFORE UPDATE ON insight_reports WHEN (NEW.kind IS NOT OLD.kind OR NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id) BEGIN SELECT RAISE(ABORT,'insight_work_identity_immutable'); END;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;

--> statement-breakpoint

CREATE UNIQUE INDEX weekly_question_identity ON insight_reports(delivery_id) WHERE kind='weekly-question';
--> statement-breakpoint

CREATE UNIQUE INDEX proactivity_request_identity ON insight_reports(delivery_id) WHERE kind='offer-request';
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP TRIGGER billing_attempt_detached_source;
--> statement-breakpoint

DROP TRIGGER billing_followup_cancellation_stop;
--> statement-breakpoint

DROP TRIGGER erasure_fence_subscription_cancellations_delete;
--> statement-breakpoint

DROP TRIGGER erasure_fence_subscription_cancellations_insert;
--> statement-breakpoint

DROP TRIGGER erasure_fence_subscription_cancellations_update;
--> statement-breakpoint

DROP TRIGGER erasure_preserve_subscription_cancellations_delete;
--> statement-breakpoint

DROP TRIGGER subscription_cancellation_fence;
--> statement-breakpoint

DROP TRIGGER subscription_cancellation_immutable;
--> statement-breakpoint

DROP TRIGGER subscription_cancellation_no_delete;
--> statement-breakpoint

DROP TRIGGER subscription_cancellation_guard;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_paid_attempt_id TEXT REFERENCES billing_attempts(paid_attempt_id);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_payment_source_id TEXT REFERENCES card_payment_sources(id);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_cancelled_at_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_paid_through_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_source_cancellation TEXT CHECK(cancellation_source_cancellation IS NULL OR cancellation_source_cancellation IN ('detached','void-pending','voided'));
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_void_started_at_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_void_verified_at_ms INTEGER;
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_verification_count INTEGER CHECK(cancellation_verification_count IS NULL OR cancellation_verification_count BETWEEN 0 AND 8);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN cancellation_last_offered_at_ms INTEGER CHECK((cancellation_cancelled_at_ms IS NULL AND cancellation_paid_attempt_id IS NULL AND cancellation_payment_source_id IS NULL AND cancellation_paid_through_ms IS NULL AND cancellation_source_cancellation IS NULL AND cancellation_void_started_at_ms IS NULL AND cancellation_void_verified_at_ms IS NULL AND cancellation_verification_count IS NULL AND cancellation_last_offered_at_ms IS NULL) OR (cancellation_cancelled_at_ms IS NOT NULL AND cancellation_paid_attempt_id IS NOT NULL AND cancellation_payment_source_id IS NOT NULL AND cancellation_paid_through_ms IS NOT NULL AND cancellation_source_cancellation IS NOT NULL AND cancellation_verification_count IS NOT NULL));
--> statement-breakpoint

UPDATE users SET cancellation_paid_attempt_id=c.paid_attempt_id,cancellation_payment_source_id=c.payment_source_id,cancellation_cancelled_at_ms=c.cancelled_at_ms,cancellation_paid_through_ms=c.paid_through_ms,cancellation_source_cancellation=c.source_cancellation,cancellation_void_started_at_ms=c.void_started_at_ms,cancellation_void_verified_at_ms=c.void_verified_at_ms,cancellation_verification_count=c.verification_count,cancellation_last_offered_at_ms=c.last_offered_at_ms FROM subscription_cancellations c WHERE users.id=c.user_id;
--> statement-breakpoint

CREATE TRIGGER billing_attempt_detached_source BEFORE INSERT ON billing_attempts
WHEN EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) WHERE payment_source_id=NEW.payment_source_id)
BEGIN
 SELECT RAISE(ABORT, 'billing_source_detached');
END;
--> statement-breakpoint

CREATE TRIGGER billing_followup_cancellation_stop BEFORE UPDATE OF followup_kind,followup_due_at_ms ON billing_attempts
WHEN OLD.followup_kind IS NULL AND NEW.followup_kind IS NOT NULL AND (EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) c JOIN billing_attempts a ON a.user_id=c.user_id WHERE a.id=NEW.id))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_delete BEFORE DELETE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_insert BEFORE INSERT ON users
WHEN NEW.cancellation_cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_subscription_cancellations_update BEFORE UPDATE ON users
WHEN (NEW.cancellation_paid_attempt_id IS NOT OLD.cancellation_paid_attempt_id OR NEW.cancellation_payment_source_id IS NOT OLD.cancellation_payment_source_id OR NEW.cancellation_cancelled_at_ms IS NOT OLD.cancellation_cancelled_at_ms OR NEW.cancellation_paid_through_ms IS NOT OLD.cancellation_paid_through_ms OR NEW.cancellation_source_cancellation IS NOT OLD.cancellation_source_cancellation OR NEW.cancellation_void_started_at_ms IS NOT OLD.cancellation_void_started_at_ms OR NEW.cancellation_void_verified_at_ms IS NOT OLD.cancellation_void_verified_at_ms OR NEW.cancellation_verification_count IS NOT OLD.cancellation_verification_count OR NEW.cancellation_last_offered_at_ms IS NOT OLD.cancellation_last_offered_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='subscription_cancellations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscription_cancellations_delete BEFORE DELETE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_cancellations','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'paid_attempt_id',OLD.cancellation_paid_attempt_id,'payment_source_id',OLD.cancellation_payment_source_id,'cancelled_at_ms',OLD.cancellation_cancelled_at_ms,'paid_through_ms',OLD.cancellation_paid_through_ms,'source_cancellation',OLD.cancellation_source_cancellation,'void_started_at_ms',OLD.cancellation_void_started_at_ms,'void_verified_at_ms',OLD.cancellation_void_verified_at_ms,'verification_count',OLD.cancellation_verification_count,'last_offered_at_ms',OLD.cancellation_last_offered_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_subscription_cancellations_clear BEFORE UPDATE ON users
WHEN NEW.cancellation_cancelled_at_ms IS NULL AND OLD.cancellation_cancelled_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_cancellations','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'paid_attempt_id',OLD.cancellation_paid_attempt_id,'payment_source_id',OLD.cancellation_payment_source_id,'cancelled_at_ms',OLD.cancellation_cancelled_at_ms,'paid_through_ms',OLD.cancellation_paid_through_ms,'source_cancellation',OLD.cancellation_source_cancellation,'void_started_at_ms',OLD.cancellation_void_started_at_ms,'void_verified_at_ms',OLD.cancellation_void_verified_at_ms,'verification_count',OLD.cancellation_verification_count,'last_offered_at_ms',OLD.cancellation_last_offered_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_fence AFTER UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NULL AND NEW.cancellation_cancelled_at_ms IS NOT NULL
BEGIN
 UPDATE billing_attempts AS billing_followup_outbox SET followup_kind=NULL,followup_due_at_ms=NULL WHERE followup_kind IS NOT NULL AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.id);
 UPDATE billing_attempts AS billing_collection_work SET collection_state='rejected' WHERE collection_state IS NOT NULL AND collection_state='armed'
    AND id IN (SELECT id FROM billing_attempts WHERE user_id=NEW.id);
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_immutable BEFORE UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NOT NULL AND NEW.cancellation_cancelled_at_ms IS NOT NULL AND (NEW.id<>OLD.id OR NEW.cancellation_paid_attempt_id<>OLD.cancellation_paid_attempt_id OR NEW.cancellation_payment_source_id<>OLD.cancellation_payment_source_id
 OR NEW.cancellation_cancelled_at_ms<>OLD.cancellation_cancelled_at_ms OR NEW.cancellation_paid_through_ms<>OLD.cancellation_paid_through_ms
 OR (OLD.cancellation_source_cancellation IN ('detached','voided') AND NEW.cancellation_source_cancellation<>OLD.cancellation_source_cancellation)
 OR (OLD.cancellation_void_started_at_ms IS NOT NULL AND NEW.cancellation_void_started_at_ms IS NOT OLD.cancellation_void_started_at_ms)
 OR (OLD.cancellation_void_verified_at_ms IS NOT NULL AND NEW.cancellation_void_verified_at_ms IS NOT OLD.cancellation_void_verified_at_ms) )
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_no_delete BEFORE DELETE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_cancellations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_no_delete_clear BEFORE UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NOT NULL AND NEW.cancellation_cancelled_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_cancellations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.id=erasurePermit.user_id))
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard_insert BEFORE INSERT ON users
WHEN NEW.cancellation_cancelled_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.id AND a.id=NEW.cancellation_paid_attempt_id AND a.payment_source_id=NEW.cancellation_payment_source_id
 AND NEW.cancellation_paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.cancellation_source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

CREATE TRIGGER subscription_cancellation_guard BEFORE UPDATE ON users
WHEN OLD.cancellation_cancelled_at_ms IS NULL AND NEW.cancellation_cancelled_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_price_id AS price_id,paid_period_ends_at_ms AS paid_period_ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM users WHERE paid_attempt_id IS NOT NULL) sub JOIN billing_attempts a ON a.id=sub.attempt_id AND a.user_id=sub.user_id
 JOIN (SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempts WHERE paid_starts_at_ms IS NOT NULL) p ON p.attempt_id=a.id JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=a.user_id
 WHERE sub.user_id=NEW.id AND a.id=NEW.cancellation_paid_attempt_id AND a.payment_source_id=NEW.cancellation_payment_source_id
 AND NEW.cancellation_paid_through_ms=MIN(p.ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=p.attempt_id),p.ends_at_ms))
 AND NEW.cancellation_source_cancellation=CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END)
BEGIN
 SELECT RAISE(ABORT, 'subscription_cancellation_invalid');
END;
--> statement-breakpoint

DROP VIEW subscription_renewal_fences;
--> statement-breakpoint

CREATE VIEW subscription_renewal_fences AS
  SELECT refund_id,user_id,stopped_at_ms FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops
  UNION ALL SELECT NULL,user_id,cancelled_at_ms FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL);
--> statement-breakpoint

DROP TABLE subscription_cancellations;
--> statement-breakpoint

CREATE INDEX cancellation_dispatch_due ON users(cancellation_last_offered_at_ms,id) WHERE cancellation_source_cancellation='void-pending' AND cancellation_verification_count<8;
--> statement-breakpoint

CREATE INDEX cancellation_payment_source ON users(cancellation_payment_source_id) WHERE cancellation_cancelled_at_ms IS NOT NULL;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE recurring_evaluation_records (
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('fact','proposal')),
 id TEXT NOT NULL,
 group_key TEXT,
 occurred_at TEXT,
 fact_json TEXT,
 proposal_json TEXT,
 CHECK((kind='fact' AND group_key IS NOT NULL AND occurred_at IS NOT NULL AND fact_json IS NOT NULL AND proposal_json IS NULL)
 OR(kind='proposal' AND group_key IS NULL AND occurred_at IS NULL AND fact_json IS NULL AND proposal_json IS NOT NULL)),
 PRIMARY KEY(user_id,kind,id)
) STRICT;
--> statement-breakpoint

INSERT INTO recurring_evaluation_records SELECT user_id,'fact',id,group_key,occurred_at,fact_json,NULL FROM recurring_facts;
--> statement-breakpoint

INSERT INTO recurring_evaluation_records SELECT user_id,'proposal',proposal_key,NULL,NULL,NULL,proposal_json FROM recurring_proposals;
--> statement-breakpoint

CREATE INDEX recurring_facts_by_group_typed ON recurring_evaluation_records(user_id, group_key, occurred_at, id) WHERE kind='fact';
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='fact' OR OLD.kind='fact') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_facts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'group_key',OLD."group_key",'occurred_at',OLD."occurred_at",'fact_json',OLD."fact_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TABLE recurring_facts;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='proposal' OR OLD.kind='proposal') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_proposals','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'proposal_key',OLD.id,'proposal_json',OLD."proposal_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TABLE recurring_proposals;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_group_currencies_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_group_currencies_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_group_currencies_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_month_caps_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_month_caps_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_month_caps_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_plan_months_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_plan_months_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_budget_plan_months_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_group_currencies_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_month_caps_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_budget_plan_months_delete";
--> statement-breakpoint

DROP TRIGGER "budget_group_currency_version_update";
--> statement-breakpoint

DROP TRIGGER "budget_group_currency_version_insert";
--> statement-breakpoint

CREATE TABLE budget_month_plan_records (
 kind TEXT NOT NULL CHECK(kind IN ('cap','plan','currency')),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 month TEXT NOT NULL,
 budget_id TEXT,
 group_name TEXT,
 cap TEXT,
 currency TEXT,
 FOREIGN KEY(user_id,budget_id) REFERENCES budgets(user_id,id) ON DELETE CASCADE,
 CHECK((kind='cap' AND budget_id IS NOT NULL AND cap IS NOT NULL AND group_name IS NULL AND currency IS NULL)
 OR(kind='plan' AND budget_id IS NULL AND cap IS NULL AND group_name IS NULL AND currency IS NULL)
 OR(kind='currency' AND budget_id IS NULL AND cap IS NULL AND group_name IS NOT NULL AND currency IS NOT NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO budget_month_plan_records(kind,user_id,budget_id,month,cap) SELECT 'cap',user_id,budget_id,month,cap FROM budget_month_caps;
--> statement-breakpoint

INSERT INTO budget_month_plan_records(kind,user_id,month) SELECT 'plan',user_id,month FROM budget_plan_months;
--> statement-breakpoint

INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) SELECT 'currency',user_id,group_name,month,currency FROM budget_group_currencies;
--> statement-breakpoint

DROP TABLE budget_month_caps;
--> statement-breakpoint

DROP TABLE budget_plan_months;
--> statement-breakpoint

DROP TABLE budget_group_currencies;
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_cap_identity ON budget_month_plan_records(user_id,budget_id,month) WHERE kind='cap';
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_plan_identity ON budget_month_plan_records(user_id,month) WHERE kind='plan';
--> statement-breakpoint

CREATE UNIQUE INDEX budget_month_currency_identity ON budget_month_plan_records(user_id,group_name,month) WHERE kind='currency';
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_group_currencies_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='currency' OR OLD.kind='currency') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_month_caps_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='cap' OR OLD.kind='cap') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_insert BEFORE INSERT ON budget_month_plan_records
WHEN NEW.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_budget_plan_months_update BEFORE UPDATE ON budget_month_plan_records
WHEN (NEW.kind='plan' OR OLD.kind='plan') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_group_currencies_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='currency' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_group_currencies','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'group_name',OLD."group_name",'month',OLD."month",'currency',OLD."currency")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_month_caps_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='cap' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_month_caps','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'budget_id',OLD."budget_id",'month',OLD."month",'cap',OLD."cap")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_budget_plan_months_delete BEFORE DELETE ON budget_month_plan_records
WHEN OLD.kind='plan' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_plan_months','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'month',OLD."month")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_update AFTER UPDATE ON budget_month_plan_records
WHEN (NEW.kind='currency' OR OLD.kind='currency')
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_group_currency_version_insert AFTER INSERT ON budget_month_plan_records
WHEN NEW.kind='currency'
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at,record_id) DO UPDATE SET revision=coalesce(revision,0)+1;
END;
--> statement-breakpoint

CREATE TRIGGER budget_month_plan_kind_immutable BEFORE UPDATE ON budget_month_plan_records WHEN NEW.kind IS NOT OLD.kind BEGIN SELECT RAISE(ABORT,'budget_month_plan_kind_immutable'); END;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE recurring_digest_items(
 user_id TEXT NOT NULL REFERENCES users(id),
 confirmation_id TEXT NOT NULL,
 confirmed_at_ms INTEGER,
 context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json)),
 item_json TEXT,
 eligible TEXT CHECK(eligible IS NULL OR eligible IN ('eligible','suppressed','invalid','legacy')),
 disposition TEXT CHECK(disposition IS NULL OR disposition IN ('included','suppressed','invalid','excluded')),
 CHECK((confirmed_at_ms IS NULL AND context_json IS NULL AND item_json IS NULL AND eligible IS NULL)
 OR(confirmed_at_ms IS NOT NULL AND context_json IS NOT NULL AND eligible IS NOT NULL)),
 CHECK(confirmed_at_ms IS NOT NULL OR disposition IS NOT NULL),
 PRIMARY KEY(user_id,confirmation_id)
) STRICT;
--> statement-breakpoint

INSERT INTO recurring_digest_items SELECT s.user_id,s.confirmation_id,s.confirmed_at_ms,s.context_json,s.item_json,s.eligible,c.disposition
 FROM recurring_digest_staging s LEFT JOIN recurring_digest_consumption c USING(user_id,confirmation_id);
--> statement-breakpoint

INSERT INTO recurring_digest_items(user_id,confirmation_id,disposition) SELECT c.user_id,c.confirmation_id,c.disposition FROM recurring_digest_consumption c WHERE NOT EXISTS(SELECT 1 FROM recurring_digest_staging s WHERE s.user_id=c.user_id AND s.confirmation_id=c.confirmation_id);
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_insert_shared BEFORE INSERT ON recurring_digest_items
WHEN NEW.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_staging_update_shared BEFORE UPDATE ON recurring_digest_items
WHEN (NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms OR NEW.context_json IS NOT OLD.context_json OR NEW.item_json IS NOT OLD.item_json OR NEW.eligible IS NOT OLD.eligible OR NEW.user_id IS NOT OLD.user_id OR NEW.confirmation_id IS NOT OLD.confirmation_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_staging')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.confirmed_at_ms IS NULL AND OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TABLE recurring_digest_staging;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_insert_shared BEFORE INSERT ON recurring_digest_items
WHEN NEW.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_consumption_update_shared BEFORE UPDATE ON recurring_digest_items
WHEN (NEW.disposition IS NOT OLD.disposition OR NEW.user_id IS NOT OLD.user_id OR NEW.confirmation_id IS NOT OLD.confirmation_id) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_consumption')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.disposition IS NULL AND OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_digest_consumption_immutable_shared BEFORE UPDATE OF disposition ON recurring_digest_items
 WHEN OLD.disposition IS NOT NULL AND NEW.disposition IS NOT NULL BEGIN SELECT RAISE(ABORT,'recurring_consumption_immutable'); END;
--> statement-breakpoint

DROP TABLE recurring_digest_consumption;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP INDEX "schedules_due";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_days_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_days_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_days_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_instructions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_instructions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_digest_instructions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_executions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_executions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_executions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_revisions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_revisions_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedule_revisions_update";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedules_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedules_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_schedules_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_canonical_request_buckets_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_canonical_request_leases_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_canonical_request_replays_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_days_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_instructions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_plan_documents_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_reminder_delivery_receipts_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_reminder_governors_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_resource_admission_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_schedule_executions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_schedule_revisions_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_schedules_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_weekly_governor_deliveries_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_weekly_governors_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_digest_instructions_companions_initial";
--> statement-breakpoint

DROP TRIGGER "schedule_executions_no_delete";
--> statement-breakpoint

DROP TRIGGER "schedule_executions_no_update";
--> statement-breakpoint

DROP TRIGGER "schedule_revisions_no_delete";
--> statement-breakpoint

DROP TRIGGER "schedule_revisions_no_update";
--> statement-breakpoint

DROP TRIGGER "schedules_identity_immutable";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "insight_delivery_attempts_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_insight_events_delete";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_preserve_update";
--> statement-breakpoint

DROP TRIGGER "budget_alert_occurrences_field_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactivity_message_events_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactivity_message_events_delete_clear";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_identity_read";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_request_admission";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_security_mutation";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_audit_entries_reminder_control";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_insight_reports_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_proactivity_offer_requests_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_weekly_question_intents_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_preserve_delete";
--> statement-breakpoint

DROP TRIGGER "recurring_opportunity_preserve_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_staging_delete_shared";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_staging_clear_shared";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_consumption_delete_shared";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_digest_consumption_clear_shared";
--> statement-breakpoint

CREATE TABLE _schedules (
 kind TEXT NOT NULL CHECK(kind IN ('weekly','reminder','digest')),
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 next_scheduled_at TEXT,
 consent_grant_id TEXT NOT NULL,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 proactivity_grant_type TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('reminder','digest') THEN 'proactivity_grant' END) VIRTUAL,
 acceptance_from_ms INTEGER,
 accepted_at_ms INTEGER,
 last_source_identity TEXT,
 next_closed_at_ms INTEGER,
 source_checkpoint TEXT,
 source_cursor TEXT,
 source_cutoff_at_ms INTEGER,
 source_complete INTEGER CHECK(source_complete IS NULL OR source_complete IN(0,1)),
 CHECK((kind='digest' AND next_scheduled_at IS NULL AND acceptance_from_ms IS NOT NULL AND accepted_at_ms IS NOT NULL)
 OR(kind<>'digest' AND next_scheduled_at IS NOT NULL AND acceptance_from_ms IS NULL AND accepted_at_ms IS NULL AND last_source_identity IS NULL AND next_closed_at_ms IS NULL AND source_checkpoint IS NULL AND source_cursor IS NULL AND source_cutoff_at_ms IS NULL AND source_complete IS NULL)),
 CHECK((source_checkpoint IS NULL AND source_cursor IS NULL AND source_cutoff_at_ms IS NULL AND source_complete IS NULL)
 OR(source_checkpoint IS NOT NULL AND source_cutoff_at_ms IS NOT NULL AND source_complete IS NOT NULL)),
 PRIMARY KEY(kind,id),
 UNIQUE(kind,user_id),
 UNIQUE(user_id,kind,id),
 FOREIGN KEY(user_id,proactivity_grant_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)
) STRICT;
--> statement-breakpoint

INSERT INTO _schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms) SELECT kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms FROM schedules;
--> statement-breakpoint

INSERT INTO _schedules(kind,user_id,id,version,enabled,snapshot_json,consent_grant_id,last_evaluated_at_ms,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete) SELECT 'digest',user_id,id,version,enabled,context_json,grant_id,last_evaluated_at_ms,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM recurring_digest_instructions;
--> statement-breakpoint

CREATE TABLE schedule_history (
 record_type TEXT NOT NULL CHECK(record_type IN ('revision','execution','digest-day')),
 kind TEXT CHECK(kind IN ('weekly','reminder')),
 user_id TEXT NOT NULL REFERENCES users(id),
 schedule_id TEXT,
 version INTEGER,
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 scheduled_at TEXT,
 outcome TEXT,
 local_date TEXT,
 day_from_ms INTEGER,
 day_to_ms INTEGER,
 insight_event_id TEXT,
 FOREIGN KEY(user_id,kind,schedule_id) REFERENCES schedules(user_id,kind,id),
 CHECK((record_type='revision' AND kind IS NOT NULL AND schedule_id IS NOT NULL AND version>0 AND version IS NOT NULL AND snapshot_json IS NOT NULL AND scheduled_at IS NULL AND outcome IS NULL)
 OR(record_type='execution' AND kind IS NOT NULL AND schedule_id IS NOT NULL AND version IS NOT NULL AND snapshot_json IS NULL AND scheduled_at IS NOT NULL AND outcome IS NOT NULL AND (outcome IN ('generated','expired') OR(kind='weekly' AND outcome='empty')))
 OR(record_type='digest-day' AND kind IS NULL AND schedule_id IS NULL AND version IS NULL AND snapshot_json IS NULL AND scheduled_at IS NULL AND outcome IS NULL)),
 CHECK((record_type='digest-day' AND local_date IS NOT NULL AND day_from_ms IS NOT NULL AND day_to_ms IS NOT NULL)
 OR(record_type<>'digest-day' AND local_date IS NULL AND day_from_ms IS NULL AND day_to_ms IS NULL AND insight_event_id IS NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO schedule_history(record_type,kind,user_id,schedule_id,version,snapshot_json) SELECT 'revision',kind,user_id,schedule_id,version,snapshot_json FROM schedule_revisions;
--> statement-breakpoint

INSERT INTO schedule_history(record_type,kind,user_id,schedule_id,version,scheduled_at,outcome) SELECT 'execution',kind,user_id,schedule_id,schedule_version,scheduled_at,outcome FROM schedule_executions;
--> statement-breakpoint

INSERT INTO schedule_history(record_type,user_id,local_date,day_from_ms,day_to_ms,insight_event_id) SELECT 'digest-day',user_id,local_date,day_from_ms,day_to_ms,insight_event_id FROM recurring_digest_days;
--> statement-breakpoint

DROP TABLE schedule_revisions;
--> statement-breakpoint

DROP TABLE schedule_executions;
--> statement-breakpoint

DROP TABLE recurring_digest_days;
--> statement-breakpoint

DROP TABLE recurring_digest_instructions;
--> statement-breakpoint

DROP TABLE schedules;
--> statement-breakpoint

ALTER TABLE _schedules RENAME TO schedules;
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_revision ON schedule_history(user_id,kind,schedule_id,version) WHERE record_type='revision';
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_execution ON schedule_history(user_id,kind,schedule_id,version,scheduled_at) WHERE record_type='execution';
--> statement-breakpoint

CREATE UNIQUE INDEX schedule_history_digest_day ON schedule_history(user_id,local_date,day_from_ms,day_to_ms) WHERE record_type='digest-day';
--> statement-breakpoint

CREATE INDEX schedules_due ON schedules(kind,enabled,last_evaluated_at_ms,next_scheduled_at,id);
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_days_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='digest-day' OR NEW.record_type='digest-day') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_days')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_delete BEFORE DELETE ON schedules
WHEN OLD.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_insert BEFORE INSERT ON schedules
WHEN NEW.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_digest_instructions_update BEFORE UPDATE ON schedules
WHEN (OLD.kind='digest' OR NEW.kind='digest') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_executions_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='execution' OR NEW.record_type='execution') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_executions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_insert BEFORE INSERT ON schedule_history
WHEN NEW.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedule_revisions_update BEFORE UPDATE ON schedule_history
WHEN (OLD.record_type='revision' OR NEW.record_type='revision') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedule_revisions')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_delete BEFORE DELETE ON schedules
WHEN OLD.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_insert BEFORE INSERT ON schedules
WHEN NEW.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_schedules_update BEFORE UPDATE ON schedules
WHEN (OLD.kind IN ('weekly','reminder') OR NEW.kind IN ('weekly','reminder')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='schedules')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_buckets_delete BEFORE DELETE ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_buckets','drain:'||lower(hex(randomblob(16))),json_object('subject',OLD."subject",'virtual_at_ms',OLD."virtual_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_leases_delete BEFORE DELETE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_leases','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_canonical_request_replays_delete BEFORE DELETE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_replays','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'operation',OLD."operation",'identity',OLD."identity",'accepted_at_ms',OLD."accepted_at_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'status',OLD."status",'body',OLD."body",'content_type',OLD."content_type")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_days_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='digest-day' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_days','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'local_date',OLD."local_date",'day_from_ms',OLD."day_from_ms",'day_to_ms',OLD."day_to_ms",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_instructions_delete BEFORE DELETE ON schedules
WHEN OLD.kind='digest' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_instructions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'version',OLD."version",'enabled',OLD."enabled",'grant_id',OLD.consent_grant_id,'context_json',OLD.snapshot_json,'acceptance_from_ms',OLD."acceptance_from_ms",'accepted_at_ms',OLD."accepted_at_ms",'last_source_identity',OLD."last_source_identity",'next_closed_at_ms',OLD."next_closed_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms",'source_checkpoint',OLD.source_checkpoint,'source_cursor',OLD.source_cursor,'source_cutoff_at_ms',OLD.source_cutoff_at_ms,'source_complete',OLD.source_complete)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_plan_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id AND OLD.kind='recurring-plan')
AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'recurring_plan_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id AND OLD.kind='recurring-plan')
 AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_reminder_delivery_receipts_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_reminder_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='reminder' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'standing_json',OLD."standing_json",'last_reply_at_ms',OLD."last_reply_at_ms",'question_id',OLD."question_id",'question_delivered_at_ms',OLD."question_delivered_at_ms",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_resource_admission_events_delete BEFORE DELETE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.scope_key=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'resource_admission_events','drain:'||lower(hex(randomblob(16))),json_object('grant_id',OLD."grant_id",'policy_key',OLD."policy_key",'dimension',OLD."dimension",'scope_key',OLD."scope_key",'policy_kind',OLD."policy_kind",'units',OLD."units",'admitted_at_epoch_ms',OLD."admitted_at_epoch_ms",'window_start_epoch_ms',OLD."window_start_epoch_ms",'expires_at_epoch_ms',OLD."expires_at_epoch_ms",'released_at_epoch_ms',OLD."released_at_epoch_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.scope_key=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedule_executions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_executions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'schedule_version',OLD.version,'scheduled_at',OLD.scheduled_at,'outcome',OLD.outcome) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedule_revisions_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedule_revisions','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'schedule_id',OLD.schedule_id,'version',OLD.version,'snapshot_json',OLD.snapshot_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_schedules_delete BEFORE DELETE ON schedules
WHEN OLD.kind IN ('weekly','reminder') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'schedules','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'id',OLD.id,'user_id',OLD.user_id,'version',OLD.version,'enabled',OLD.enabled,'snapshot_json',OLD.snapshot_json,'next_scheduled_at',OLD.next_scheduled_at,'consent_grant_id',OLD.consent_grant_id,'last_evaluated_at_ms',OLD.last_evaluated_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_governor_deliveries_delete BEFORE DELETE ON governor_delivery_receipts
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_governors_delete BEFORE DELETE ON proactivity_governors
WHEN OLD.kind='weekly' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'unanswered',OLD."unanswered",'last_reply_at_ms',OLD."last_reply_at_ms",'question_needed',OLD."question_needed",'question_delivered',OLD."question_delivered",'question_delivered_at_ms',OLD."question_delivered_at_ms",'question_event_id',OLD."question_event_id",'paused_at_ms',OLD."paused_at_ms",'notice_session_id',OLD."notice_session_id",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_digest_instructions_companions_initial BEFORE INSERT ON schedules WHEN NEW.kind='digest' AND (NEW.source_checkpoint IS NOT NULL OR NEW.source_cursor IS NOT NULL OR NEW.source_cutoff_at_ms IS NOT NULL OR NEW.source_complete IS NOT NULL) BEGIN SELECT RAISE(ABORT,'recurring_digest_instructions_companions_initial'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_executions_no_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='execution' AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_executions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_executions_no_update BEFORE UPDATE ON schedule_history WHEN (OLD.record_type='execution' OR NEW.record_type='execution') BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_revisions_no_delete BEFORE DELETE ON schedule_history
WHEN OLD.record_type='revision' AND (NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='schedule_revisions' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id))
BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedule_revisions_no_update BEFORE UPDATE ON schedule_history WHEN (OLD.record_type='revision' OR NEW.record_type='revision') BEGIN SELECT RAISE(ABORT,'schedule_history_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER schedules_identity_immutable BEFORE UPDATE ON schedules WHEN NEW.kind<>OLD.kind OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id BEGIN SELECT RAISE(ABORT,'schedule_identity_immutable'); END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND NEW.delivery_receipt_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER insight_delivery_attempts_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.delivery_receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_receipt_id,'user_id',OLD.user_id,'insight_event_id',OLD.id,'sent_at',OLD.delivery_sent_at,'channel',OLD.delivery_channel,'provider',OLD.delivery_provider,'provider_message_id',OLD.delivery_provider_message_id) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_events','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'scheduled_at',OLD."scheduled_at",'money_groups_json',OLD."money_groups_json",'lifecycle_state',OLD."lifecycle_state")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND NEW.budget_delivery_group_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER budget_alert_occurrences_field_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.budget_delivery_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_group_id',OLD.budget_delivery_group_id,'threshold',OLD.budget_threshold,'insight_event_id',OLD.id,'crossing_json',OLD.budget_crossing_json) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete BEFORE DELETE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete_clear BEFORE UPDATE ON insight_events WHEN (OLD.report_delivery_id IS NOT NULL) AND NEW.report_delivery_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.report_delivery_id,'insight_event_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_audit_entries_reminder_control BEFORE DELETE ON audit_entries
WHEN OLD.record_type='reminder_control' AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_control_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'message_id',json_extract(OLD.id,'$[1]'),'choice',OLD.outcome)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_insight_reports_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind IN ('weekly-summary','proactivity-delivery') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'insight_reports','drain:'||lower(hex(randomblob(16))),json_object('kind',OLD.kind,'user_id',OLD.user_id,'delivery_id',OLD.delivery_id,'role',OLD.role,'consent_grant_id',OLD.consent_grant_id,'offer_id',OLD.offer_id,'text',OLD.text,'scheduled_at_ms',OLD.scheduled_at_ms,'expires_at_ms',OLD.expires_at_ms,'time_zone',OLD.time_zone,'created_at_ms',OLD.created_at_ms,'payload_json',OLD.payload_json,'presentation_json',OLD.presentation_json,'reminder_grant_id',OLD.reminder_grant_id,'reminder_expires_at_ms',OLD.reminder_expires_at_ms,'instruction_id',OLD.instruction_id,'instruction_version',OLD.instruction_version,'grant_id',OLD.grant_id,'local_date',OLD.local_date,'day_from_ms',OLD.day_from_ms,'day_to_ms',OLD.day_to_ms,'report_json',OLD.report_json,'dispatch_state',OLD.dispatch_state,'dispatch_created_at_ms',OLD.dispatch_created_at_ms,'dispatch_last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'dispatch_restart_attempts',OLD.dispatch_restart_attempts) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_proactivity_offer_requests_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_offer_requests','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'kind',OLD.request_kind,'request_message_id',OLD.request_message_id,'created_at_ms',OLD.created_at_ms,'materialized_at_ms',OLD.materialized_at_ms,'last_evaluated_at_ms',OLD.last_evaluated_at_ms,'delivery_id',OLD.offer_delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_weekly_question_intents_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_question_intents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD.delivery_id,'user_id',OLD.user_id,'origin',OLD.origin,'request_message_id',OLD.request_message_id,'rejection_offer_id',OLD.rejection_offer_id,'state',OLD.dispatch_state,'created_at_ms',OLD.created_at_ms,'last_attempt_at_ms',OLD.dispatch_last_attempt_at_ms,'restart_attempts',OLD.dispatch_restart_attempts)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_delete BEFORE DELETE ON insight_reports
WHEN OLD.kind='offer-request' AND (OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER recurring_opportunity_preserve_update BEFORE UPDATE ON insight_reports
WHEN (OLD.kind='offer-request' OR NEW.kind='offer-request') AND (OLD.current_recurring_opportunity=1 AND NEW.current_recurring_opportunity IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.delivery_id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_staging_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.confirmed_at_ms IS NULL AND OLD.confirmed_at_ms IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_delete_shared BEFORE DELETE ON recurring_digest_items
WHEN OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_clear_shared BEFORE UPDATE ON recurring_digest_items
WHEN NEW.disposition IS NULL AND OLD.disposition IS NOT NULL AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE UNIQUE INDEX schedules_digest_identity ON schedules(id) WHERE kind='digest';
--> statement-breakpoint

CREATE TRIGGER schedule_history_type_immutable BEFORE UPDATE ON schedule_history WHEN NEW.record_type IS NOT OLD.record_type BEGIN SELECT RAISE(ABORT,'schedule_history_type_immutable'); END;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE erasure_custody_records (
 record_type TEXT NOT NULL CHECK(record_type IN ('current','event')),
 request_id TEXT NOT NULL REFERENCES erasure_requests(id),
 custodian TEXT NOT NULL,
 id TEXT,
 state TEXT,
 evidence_json TEXT CHECK(evidence_json IS NULL OR length(evidence_json)<=4096),
 recorded_at_ms INTEGER,
 operator_ref TEXT,
 current_event_id TEXT,
 event_identity TEXT GENERATED ALWAYS AS(CASE WHEN record_type='event' THEN id END) VIRTUAL UNIQUE,
 UNIQUE(request_id,custodian,event_identity),
 FOREIGN KEY(request_id,custodian,current_event_id) REFERENCES erasure_custody_records(request_id,custodian,event_identity),
 CHECK((record_type='current' AND id IS NULL AND state IS NOT NULL AND state IN ('Pending','Accepted','Verified','NotApplicable','Retained','Unresolved') AND custodian IN ('Cloudflare','Kapso','Meta','Resend','Wompi','SupportInbox','CaseRegister','CaseEvidence') AND evidence_json IS NULL AND recorded_at_ms IS NULL AND operator_ref IS NULL)
 OR(record_type='event' AND id IS NOT NULL AND state IS NULL AND evidence_json IS NOT NULL AND recorded_at_ms IS NOT NULL AND operator_ref IS NOT NULL AND current_event_id IS NULL))
) STRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX custody_current_identity ON erasure_custody_records(request_id,custodian) WHERE record_type='current';
--> statement-breakpoint

INSERT INTO erasure_custody_records(record_type,request_id,custodian,id,evidence_json,recorded_at_ms,operator_ref) SELECT 'event',request_id,custodian,id,evidence_json,recorded_at_ms,operator_ref FROM erasure_custody_events;
--> statement-breakpoint

INSERT INTO erasure_custody_records(record_type,request_id,custodian,state,current_event_id) SELECT 'current',c.request_id,c.custodian,c.state,(SELECT e.id FROM erasure_custody_events e WHERE e.request_id=c.request_id AND e.custodian=c.custodian AND e.evidence_json=c.evidence_json ORDER BY e.recorded_at_ms DESC,e.id DESC LIMIT 1) FROM erasure_custody_evidence c;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity (violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM erasure_custody_evidence c WHERE c.evidence_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_custody_records r WHERE r.record_type='current' AND r.request_id=c.request_id AND r.custodian=c.custodian AND r.current_event_id IS NOT NULL);
--> statement-breakpoint

DROP TABLE erasure_custody_evidence;
--> statement-breakpoint

DROP TABLE erasure_custody_events;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;

--> statement-breakpoint

CREATE TRIGGER custody_record_identity_immutable BEFORE UPDATE ON erasure_custody_records WHEN NEW.record_type IS NOT OLD.record_type OR NEW.request_id IS NOT OLD.request_id OR NEW.custodian IS NOT OLD.custodian OR NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'custody_record_identity_immutable'); END;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP TRIGGER insight_events_immutable;
--> statement-breakpoint

DROP TRIGGER erasure_fence_insight_reports_update;
--> statement-breakpoint

CREATE TABLE _governor_upgrade_integrity(violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

ALTER TABLE insight_events ADD COLUMN weekly_governor_counted INTEGER CHECK(weekly_governor_counted IS NULL OR (weekly_governor_counted=1 AND kind='weekly-summary'));
--> statement-breakpoint

INSERT INTO _governor_upgrade_integrity SELECT count(*) FROM governor_delivery_receipts r WHERE r.kind='weekly' AND NOT EXISTS(SELECT 1 FROM insight_events p WHERE p.user_id=r.user_id AND p.id=r.insight_event_id AND p.kind='weekly-summary');
--> statement-breakpoint

UPDATE insight_events SET weekly_governor_counted=1 WHERE (user_id,id) IN (SELECT user_id,insight_event_id FROM governor_delivery_receipts WHERE kind='weekly') AND kind='weekly-summary';
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_fence BEFORE UPDATE ON insight_events WHEN NEW.weekly_governor_counted IS NOT OLD.weekly_governor_counted AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_insert_fence BEFORE INSERT ON insight_events WHEN NEW.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_delete_fence BEFORE DELETE ON insight_events WHEN OLD.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_deliveries')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_preserve_update BEFORE UPDATE ON insight_events WHEN OLD.weekly_governor_counted=1 AND NEW.weekly_governor_counted IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'insight_event_id',OLD.id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER weekly_governor_deliveries_marker_preserve_delete BEFORE DELETE ON insight_events WHEN OLD.weekly_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'insight_event_id',OLD.id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE INDEX weekly_governor_deliveries_marker_user ON insight_events(user_id,id) WHERE weekly_governor_counted=1;
--> statement-breakpoint

ALTER TABLE insight_reports ADD COLUMN reminder_governor_counted INTEGER CHECK(reminder_governor_counted IS NULL OR (reminder_governor_counted=1 AND kind='proactivity-delivery'));
--> statement-breakpoint

INSERT INTO _governor_upgrade_integrity SELECT count(*) FROM governor_delivery_receipts r WHERE r.kind='reminder' AND NOT EXISTS(SELECT 1 FROM insight_reports p WHERE p.user_id=r.user_id AND p.delivery_id=r.delivery_id AND p.kind='proactivity-delivery');
--> statement-breakpoint

UPDATE insight_reports SET reminder_governor_counted=1 WHERE (user_id,delivery_id) IN (SELECT user_id,delivery_id FROM governor_delivery_receipts WHERE kind='reminder') AND kind='proactivity-delivery';
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_fence BEFORE UPDATE ON insight_reports WHEN NEW.reminder_governor_counted IS NOT OLD.reminder_governor_counted AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_insert_fence BEFORE INSERT ON insight_reports WHEN NEW.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_delete_fence BEFORE DELETE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_delivery_receipts')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_preserve_update BEFORE UPDATE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND NEW.reminder_governor_counted IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.delivery_id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE TRIGGER reminder_delivery_receipts_marker_preserve_delete BEFORE DELETE ON insight_reports WHEN OLD.reminder_governor_counted=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'delivery_id',OLD.delivery_id) FROM erasure_requests q WHERE q.user_id=OLD.user_id AND q.state='Draining' AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000; END;
--> statement-breakpoint

CREATE INDEX reminder_delivery_receipts_marker_user ON insight_reports(user_id,delivery_id) WHERE reminder_governor_counted=1;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_insight_reports_update BEFORE UPDATE ON insight_reports
WHEN (NEW.kind IS NOT OLD.kind OR NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id OR NEW.origin IS NOT OLD.origin OR NEW.request_message_id IS NOT OLD.request_message_id OR NEW.rejection_offer_id IS NOT OLD.rejection_offer_id OR NEW.request_kind IS NOT OLD.request_kind OR NEW.materialized_at_ms IS NOT OLD.materialized_at_ms OR NEW.last_evaluated_at_ms IS NOT OLD.last_evaluated_at_ms OR NEW.offer_delivery_id IS NOT OLD.offer_delivery_id OR NEW.current_recurring_opportunity IS NOT OLD.current_recurring_opportunity OR NEW.role IS NOT OLD.role OR NEW.consent_grant_id IS NOT OLD.consent_grant_id OR NEW.offer_id IS NOT OLD.offer_id OR NEW.text IS NOT OLD.text OR NEW.scheduled_at_ms IS NOT OLD.scheduled_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.time_zone IS NOT OLD.time_zone OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.payload_json IS NOT OLD.payload_json OR NEW.presentation_json IS NOT OLD.presentation_json OR NEW.reminder_grant_id IS NOT OLD.reminder_grant_id OR NEW.reminder_expires_at_ms IS NOT OLD.reminder_expires_at_ms OR NEW.instruction_id IS NOT OLD.instruction_id OR NEW.instruction_version IS NOT OLD.instruction_version OR NEW.grant_id IS NOT OLD.grant_id OR NEW.local_date IS NOT OLD.local_date OR NEW.day_from_ms IS NOT OLD.day_from_ms OR NEW.day_to_ms IS NOT OLD.day_to_ms OR NEW.report_json IS NOT OLD.report_json OR NEW.dispatch_state IS NOT OLD.dispatch_state OR NEW.dispatch_created_at_ms IS NOT OLD.dispatch_created_at_ms OR NEW.dispatch_last_attempt_at_ms IS NOT OLD.dispatch_last_attempt_at_ms OR NEW.dispatch_restart_attempts IS NOT OLD.dispatch_restart_attempts) AND (OLD.kind IN ('weekly-summary','proactivity-delivery') OR NEW.kind IN ('weekly-summary','proactivity-delivery')) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_reports')))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

DROP TABLE governor_delivery_receipts;
--> statement-breakpoint

DROP TABLE _governor_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;

--> statement-breakpoint

CREATE TRIGGER insight_events_immutable BEFORE UPDATE ON insight_events
WHEN NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind
  OR NEW.schedule_id <> OLD.schedule_id OR NEW.schedule_version <> OLD.schedule_version
  OR NEW.service_market <> OLD.service_market OR NEW.locale <> OLD.locale
  OR NEW.time_zone <> OLD.time_zone OR NEW.scheduled_at <> OLD.scheduled_at
  OR NEW.money_groups_json <> OLD.money_groups_json
  OR NOT ((OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state IN ('delivered','read','dismissed'))
    OR (OLD.lifecycle_state = 'delivered' AND NEW.lifecycle_state IN ('read','dismissed'))
    OR (OLD.lifecycle_state = 'read' AND NEW.lifecycle_state = 'dismissed')
    OR (NEW.lifecycle_state=OLD.lifecycle_state AND ((NEW.budget_delivery_group_id IS NOT OLD.budget_delivery_group_id OR NEW.budget_threshold IS NOT OLD.budget_threshold OR NEW.budget_crossing_json IS NOT OLD.budget_crossing_json) OR NEW.report_delivery_id IS NOT OLD.report_delivery_id OR NEW.transcript_id IS NOT OLD.transcript_id OR NEW.transcript_kind IS NOT OLD.transcript_kind OR NEW.delivery_receipt_id IS NOT OLD.delivery_receipt_id OR NEW.delivery_sent_at IS NOT OLD.delivery_sent_at OR NEW.delivery_channel IS NOT OLD.delivery_channel OR NEW.delivery_provider IS NOT OLD.delivery_provider OR NEW.delivery_provider_message_id IS NOT OLD.delivery_provider_message_id OR NEW.weekly_governor_counted IS NOT OLD.weekly_governor_counted)))
BEGIN SELECT RAISE(ABORT, 'insight_transition_invalid'); END;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

DROP INDEX "recurring_unfinished_users";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_progress_delete";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_progress_insert";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_progress_update";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_progress_delete";
--> statement-breakpoint

DROP INDEX "recurring_facts_by_group_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_facts_delete_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_facts_insert_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_facts_update_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_facts_delete_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_proposals_delete_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_proposals_insert_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_fence_recurring_proposals_update_typed";
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_recurring_proposals_delete_typed";
--> statement-breakpoint

CREATE TABLE _recurring_evaluation_records (
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('fact','proposal','progress')),
 id TEXT NOT NULL,
 group_key TEXT,
 occurred_at TEXT,
 fact_json TEXT,
 proposal_json TEXT,
 revision INTEGER,
 phase TEXT CHECK(phase IN ('scan','detect','complete')),
 cursor_at TEXT,
 cursor_id TEXT,
 evaluated_at TEXT,
 evaluated_revision INTEGER,
 first_captured_at TEXT,
 time_zone TEXT,
 CHECK((kind='fact' AND group_key IS NOT NULL AND occurred_at IS NOT NULL AND fact_json IS NOT NULL AND proposal_json IS NULL)
 OR(kind='proposal' AND group_key IS NULL AND occurred_at IS NULL AND fact_json IS NULL AND proposal_json IS NOT NULL)
 OR(kind='progress' AND id='progress' AND group_key IS NOT NULL AND occurred_at IS NULL AND fact_json IS NULL AND proposal_json IS NULL)),
 CHECK((kind='progress' AND revision IS NOT NULL AND phase IS NOT NULL AND cursor_at IS NOT NULL AND cursor_id IS NOT NULL AND evaluated_revision IS NOT NULL AND first_captured_at IS NOT NULL AND time_zone IS NOT NULL)
 OR(kind<>'progress' AND revision IS NULL AND phase IS NULL AND cursor_at IS NULL AND cursor_id IS NULL AND evaluated_at IS NULL AND evaluated_revision IS NULL AND first_captured_at IS NULL AND time_zone IS NULL)),
 PRIMARY KEY(user_id,kind,id)
) STRICT;
--> statement-breakpoint

INSERT INTO _recurring_evaluation_records(user_id,kind,id,group_key,occurred_at,fact_json,proposal_json) SELECT user_id,kind,id,group_key,occurred_at,fact_json,proposal_json FROM recurring_evaluation_records;
--> statement-breakpoint

INSERT INTO _recurring_evaluation_records(user_id,kind,id,revision,phase,cursor_at,cursor_id,group_key,evaluated_at,evaluated_revision,first_captured_at,time_zone) SELECT user_id,'progress','progress',revision,phase,cursor_at,cursor_id,group_key,evaluated_at,evaluated_revision,first_captured_at,time_zone FROM recurring_progress;
--> statement-breakpoint

DROP TABLE recurring_evaluation_records;
--> statement-breakpoint

DROP TABLE recurring_progress;
--> statement-breakpoint

ALTER TABLE _recurring_evaluation_records RENAME TO recurring_evaluation_records;
--> statement-breakpoint

CREATE INDEX recurring_unfinished_users ON recurring_evaluation_records(user_id) WHERE phase<>'complete' AND kind='progress';
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_delete BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_insert BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_progress_update BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='progress' OR OLD.kind='progress') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_progress')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_progress_delete BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='progress' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_progress','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'phase',OLD."phase",'cursor_at',OLD."cursor_at",'cursor_id',OLD."cursor_id",'group_key',OLD."group_key",'evaluated_at',OLD."evaluated_at",'evaluated_revision',OLD."evaluated_revision",'first_captured_at',OLD."first_captured_at",'time_zone',OLD."time_zone")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE INDEX recurring_facts_by_group_typed ON recurring_evaluation_records(user_id, group_key, occurred_at, id) WHERE kind='fact';
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_facts_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='fact' OR OLD.kind='fact') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_facts')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_facts_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='fact' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_facts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'group_key',OLD."group_key",'occurred_at',OLD."occurred_at",'fact_json',OLD."fact_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_insert_typed BEFORE INSERT ON recurring_evaluation_records
WHEN NEW.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_recurring_proposals_update_typed BEFORE UPDATE ON recurring_evaluation_records
WHEN (NEW.kind='proposal' OR OLD.kind='proposal') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_proposals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_recurring_proposals_delete_typed BEFORE DELETE ON recurring_evaluation_records
WHEN OLD.kind='proposal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_proposals','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'proposal_key',OLD.id,'proposal_json',OLD."proposal_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity(violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE whatsapp_event_records (
 kind TEXT NOT NULL CHECK(kind IN ('voice-refusal','delivery-status')),
 portfolio_id TEXT,
 message_id TEXT,
 user_id TEXT,
 claimed_at_ms INTEGER,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('started','accepted','failed')),
 correlation_token TEXT REFERENCES whatsapp_deliveries(hosted_correlation_token),
 provider_message_id TEXT,
 status TEXT CHECK(status IS NULL OR status IN ('sent','delivered','failed')),
 occurred_at_ms INTEGER,
 received_at_ms INTEGER,
 CHECK((kind='voice-refusal' AND portfolio_id IS NOT NULL AND message_id IS NOT NULL AND user_id IS NOT NULL AND claimed_at_ms IS NOT NULL AND outcome IS NOT NULL AND correlation_token IS NULL AND provider_message_id IS NULL AND status IS NULL AND occurred_at_ms IS NULL AND received_at_ms IS NULL)
 OR(kind='delivery-status' AND portfolio_id IS NULL AND message_id IS NULL AND user_id IS NULL AND claimed_at_ms IS NULL AND outcome IS NULL AND correlation_token IS NOT NULL AND provider_message_id IS NOT NULL AND status IS NOT NULL AND occurred_at_ms IS NOT NULL AND received_at_ms IS NOT NULL))
) STRICT;
--> statement-breakpoint

INSERT INTO whatsapp_event_records(kind,portfolio_id,message_id,user_id,claimed_at_ms,outcome) SELECT 'voice-refusal',portfolio_id,message_id,user_id,claimed_at_ms,outcome FROM hosted_voice_refusals;
--> statement-breakpoint

INSERT INTO whatsapp_event_records(kind,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) SELECT 'delivery-status',correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms FROM hosted_whatsapp_delivery_events;
--> statement-breakpoint

CREATE UNIQUE INDEX voice_refusal_identity ON whatsapp_event_records(portfolio_id,message_id) WHERE kind='voice-refusal';
--> statement-breakpoint

CREATE UNIQUE INDEX delivery_status_identity ON whatsapp_event_records(correlation_token,provider_message_id,status,occurred_at_ms) WHERE kind='delivery-status';
--> statement-breakpoint

DROP INDEX "hosted_voice_refusals_user_window";
--> statement-breakpoint

CREATE INDEX hosted_voice_refusals_user_window
  ON whatsapp_event_records (user_id, claimed_at_ms) WHERE kind='voice-refusal';
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_voice_refusals_delete";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_voice_refusals_insert";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_insert BEFORE INSERT ON whatsapp_event_records
WHEN NEW.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_voice_refusals_update";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_voice_refusals_update BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='voice-refusal' OR NEW.kind='voice-refusal') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_voice_refusals')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_hosted_voice_refusals_delete";
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_voice_refusals_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='voice-refusal' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_voice_refusals','drain:'||lower(hex(randomblob(16))),json_object('portfolio_id',OLD."portfolio_id",'message_id',OLD."message_id",'user_id',OLD."user_id",'claimed_at_ms',OLD."claimed_at_ms",'outcome',OLD."outcome")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TABLE hosted_voice_refusals;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_whatsapp_delivery_events_delete";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_whatsapp_delivery_events_insert";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_insert BEFORE INSERT ON whatsapp_event_records
WHEN NEW.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_fence_hosted_whatsapp_delivery_events_update";
--> statement-breakpoint

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_update BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='delivery-status' OR NEW.kind='delivery-status') AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events')))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

DROP TRIGGER "erasure_preserve_hosted_whatsapp_delivery_events_delete";
--> statement-breakpoint

CREATE TRIGGER erasure_preserve_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON whatsapp_event_records
WHEN OLD.kind='delivery-status' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000))
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_delivery_events','drain:'||lower(hex(randomblob(16))),json_object('provider_message_id',OLD."provider_message_id",'status',OLD."status",'occurred_at_ms',OLD."occurred_at_ms",'received_at_ms',OLD."received_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;
--> statement-breakpoint

DROP TRIGGER "hosted_whatsapp_delivery_event_immutable";
--> statement-breakpoint

CREATE TRIGGER hosted_whatsapp_delivery_event_immutable BEFORE UPDATE ON whatsapp_event_records
WHEN (OLD.kind='delivery-status' OR NEW.kind='delivery-status') BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_event_immutable'); END;
--> statement-breakpoint

DROP TABLE hosted_whatsapp_delivery_events;
--> statement-breakpoint

CREATE TRIGGER whatsapp_event_kind_immutable BEFORE UPDATE ON whatsapp_event_records WHEN NEW.kind IS NOT OLD.kind BEGIN SELECT RAISE(ABORT,'whatsapp_event_kind_immutable'); END;
--> statement-breakpoint

CREATE TABLE _schema_upgrade_integrity(violations INTEGER NOT NULL CHECK(violations=0)) STRICT;
--> statement-breakpoint

INSERT INTO _schema_upgrade_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint

DROP TABLE _schema_upgrade_integrity;
--> statement-breakpoint

PRAGMA defer_foreign_keys=OFF;
