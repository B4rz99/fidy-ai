PRAGMA defer_foreign_keys=ON;

DROP TRIGGER erasure_fence_dashboard_documents_insert;

DROP TRIGGER erasure_fence_dashboard_documents_update;

DROP TRIGGER erasure_fence_dashboard_documents_delete;

DROP TRIGGER erasure_preserve_dashboard_documents_delete;

DROP TRIGGER erasure_fence_recurring_plan_documents_insert;

DROP TRIGGER erasure_fence_recurring_plan_documents_update;

DROP TRIGGER erasure_fence_recurring_plan_documents_delete;

DROP TRIGGER erasure_preserve_recurring_plan_documents_delete;

CREATE TABLE user_documents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('dashboard','recurring-plan')),document_json TEXT NOT NULL CHECK(json_valid(document_json)),revision INTEGER NOT NULL CHECK(revision>=1),PRIMARY KEY(user_id,kind)) STRICT;

INSERT INTO user_documents(user_id,kind,document_json,revision) SELECT user_id,'dashboard',document_json,revision FROM dashboard_documents;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_dashboard_documents',((SELECT count(*) FROM dashboard_documents)=(SELECT count(*) FROM user_documents WHERE kind='dashboard')) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE dashboard_documents;

CREATE TRIGGER erasure_fence_dashboard_documents_insert BEFORE INSERT ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='dashboard')) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_dashboard_documents_update BEFORE UPDATE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (((NEW.user_id=q.user_id AND NEW.kind='dashboard')) OR ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_dashboard_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard')) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_dashboard_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
  FROM erasure_requests q WHERE q.state='Draining' AND ((OLD.user_id=q.user_id AND OLD.kind='dashboard'))
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

INSERT INTO user_documents(user_id,kind,document_json,revision) SELECT user_id,'recurring-plan',document_json,revision FROM recurring_plan_documents;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_recurring_plan_documents',((SELECT count(*) FROM recurring_plan_documents)=(SELECT count(*) FROM user_documents WHERE kind='recurring-plan')) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE recurring_plan_documents;

CREATE TRIGGER erasure_fence_recurring_plan_documents_insert BEFORE INSERT ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_plan_documents_update BEFORE UPDATE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id AND NEW.kind='recurring-plan') OR (OLD.user_id=q.user_id AND OLD.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_plan_documents_delete BEFORE DELETE ON user_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((OLD.user_id=q.user_id AND OLD.kind='recurring-plan'))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_plan_documents'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

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
