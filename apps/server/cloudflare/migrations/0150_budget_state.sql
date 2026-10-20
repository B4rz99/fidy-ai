PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS budget_work_version_insert;

DROP TRIGGER IF EXISTS budget_work_version_update;

DROP TRIGGER IF EXISTS budget_capture_work;

DROP TRIGGER IF EXISTS budget_correction_work;

DROP TRIGGER IF EXISTS budget_link_work;

DROP TRIGGER IF EXISTS budget_unlink_work;

DROP TRIGGER IF EXISTS budget_created_work;

DROP TRIGGER IF EXISTS budget_revised_work;

DROP TRIGGER IF EXISTS budget_first_creation_capture;

DROP TRIGGER IF EXISTS budget_group_currency_version_insert;

DROP TRIGGER IF EXISTS budget_group_currency_version_update;

DROP TRIGGER IF EXISTS erasure_fence_budget_first_creation_insert;

DROP TRIGGER IF EXISTS erasure_fence_budget_first_creation_update;

DROP TRIGGER IF EXISTS erasure_fence_budget_first_creation_delete;

DROP TRIGGER IF EXISTS erasure_fence_budget_reconciliation_work_insert;

DROP TRIGGER IF EXISTS erasure_fence_budget_reconciliation_work_update;

DROP TRIGGER IF EXISTS erasure_fence_budget_reconciliation_work_delete;

DROP TRIGGER IF EXISTS erasure_fence_budget_user_versions_insert;

DROP TRIGGER IF EXISTS erasure_fence_budget_user_versions_update;

DROP TRIGGER IF EXISTS erasure_fence_budget_user_versions_delete;

DROP TRIGGER IF EXISTS erasure_preserve_budget_first_creation_delete;

DROP TRIGGER IF EXISTS erasure_preserve_budget_reconciliation_work_delete;

DROP TRIGGER IF EXISTS erasure_preserve_budget_user_versions_delete;

DROP TRIGGER IF EXISTS budget_removed_version;

CREATE TABLE budget_state (
 kind TEXT NOT NULL CHECK(kind IN ('user','work')),user_id TEXT NOT NULL REFERENCES users(id),occurred_at TEXT NOT NULL DEFAULT '',
 revision INTEGER CHECK(revision>=1),budget_id TEXT,created_at_ms INTEGER,offer_requested_at_ms INTEGER,first_last_evaluated_at_ms INTEGER,
 version INTEGER DEFAULT 1,last_evaluated_at_ms INTEGER DEFAULT 0,
 PRIMARY KEY(kind,user_id,occurred_at),
 CHECK((kind='user' AND occurred_at='' AND version IS NULL AND last_evaluated_at_ms IS NULL
   AND ((budget_id IS NULL AND created_at_ms IS NULL AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL)
    OR(budget_id IS NOT NULL AND created_at_ms IS NOT NULL AND first_last_evaluated_at_ms IS NOT NULL)))
 OR(kind='work' AND revision IS NULL AND budget_id IS NULL AND created_at_ms IS NULL
   AND offer_requested_at_ms IS NULL AND first_last_evaluated_at_ms IS NULL AND version IS NOT NULL AND last_evaluated_at_ms IS NOT NULL))
) STRICT;

INSERT INTO budget_state(kind,user_id,revision,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) SELECT 'user',u.user_id,v.revision,f.budget_id,f.created_at_ms,f.offer_requested_at_ms,f.last_evaluated_at_ms,NULL,NULL FROM (SELECT user_id FROM budget_user_versions UNION SELECT user_id FROM budget_first_creation) u LEFT JOIN budget_user_versions v USING(user_id) LEFT JOIN budget_first_creation f USING(user_id);

INSERT INTO budget_state(kind,user_id,occurred_at,version,last_evaluated_at_ms) SELECT 'work',user_id,occurred_at,version,last_evaluated_at_ms FROM budget_reconciliation_work;

DROP TABLE budget_user_versions;

DROP TABLE budget_reconciliation_work;

DROP TABLE budget_first_creation;

CREATE TRIGGER budget_work_version_insert AFTER INSERT ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET revision=coalesce(revision,0)+1; END;

CREATE TRIGGER budget_work_version_update AFTER UPDATE ON budget_state
WHEN NEW.kind='work'
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET revision=coalesce(revision,0)+1; END;

CREATE TRIGGER budget_capture_work AFTER INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_correction_work AFTER UPDATE ON transactions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, NEW.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1;
  INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',OLD.user_id, OLD.occurred_at)
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_link_work AFTER INSERT ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_unlink_work AFTER UPDATE ON transaction_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) SELECT 'work', NEW.user_id, occurred_at FROM transactions
  WHERE user_id = NEW.user_id AND id IN (NEW.first_transaction_id, NEW.second_transaction_id)
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_created_work AFTER INSERT ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_revised_work AFTER UPDATE ON budgets
BEGIN INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',NEW.user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET version = version + 1; END;

CREATE TRIGGER budget_first_creation_capture AFTER INSERT ON budgets
BEGIN
 INSERT INTO budget_state(kind,user_id,budget_id,created_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,NEW.id,CAST(unixepoch(NEW.created_at)*1000 AS INTEGER),0,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET budget_id=excluded.budget_id,created_at_ms=excluded.created_at_ms,first_last_evaluated_at_ms=0 WHERE budget_state.budget_id IS NULL;
END;

CREATE TRIGGER budget_group_currency_version_insert AFTER INSERT ON budget_group_currencies
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET revision=coalesce(revision,0)+1;
END;

CREATE TRIGGER budget_group_currency_version_update AFTER UPDATE ON budget_group_currencies
BEGIN
  INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',NEW.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET revision=coalesce(revision,0)+1;
END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_insert BEFORE INSERT ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_update BEFORE UPDATE ON budget_state
WHEN NEW.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_state'))
) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_budget_reconciliation_work_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='work' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_reconciliation_work','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'occurred_at',OLD."occurred_at",'version',OLD."version",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_budget_user_versions_delete BEFORE DELETE ON budget_state
WHEN OLD.kind='user' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
) BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_user_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'budget_id',OLD.budget_id,'created_at_ms',OLD.created_at_ms,'offer_requested_at_ms',OLD.offer_requested_at_ms,'first_last_evaluated_at_ms',OLD.first_last_evaluated_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER budget_removed_version AFTER DELETE ON budgets
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='budgets' AND (OLD.user_id=q.user_id))
BEGIN INSERT INTO budget_state(kind,user_id,revision,version,last_evaluated_at_ms) VALUES('user',OLD.user_id,1,NULL,NULL) ON CONFLICT(kind,user_id,occurred_at) DO UPDATE SET revision=coalesce(revision,0)+1;
  DELETE FROM budget_state WHERE kind='work' AND user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM budgets WHERE user_id = OLD.user_id); END;

CREATE TRIGGER budget_state_kind_immutable BEFORE UPDATE OF kind ON budget_state WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'budget_state_kind_immutable'); END;

CREATE INDEX budget_work_due ON budget_state(last_evaluated_at_ms,user_id,occurred_at) WHERE kind='work';

CREATE INDEX budget_first_offer_due ON budget_state(first_last_evaluated_at_ms,user_id) WHERE kind='user' AND budget_id IS NOT NULL;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_budget_state',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_budget_state';

PRAGMA defer_foreign_keys=OFF;
