-- Projection readiness and Transaction fact revision remain independent field groups.
DROP TRIGGER transaction_fact_insert;

DROP TRIGGER transaction_fact_update;

DROP TRIGGER transaction_fact_attestation;

DROP TRIGGER transaction_fact_link_insert;

DROP TRIGGER transaction_fact_link_update;

DROP TRIGGER transaction_fact_delete;

DROP TRIGGER transaction_fact_link_delete;

DROP TRIGGER erasure_fence_dashboard_projection_state_insert;

DROP TRIGGER erasure_fence_dashboard_projection_state_update;

DROP TRIGGER erasure_fence_dashboard_projection_state_delete;

ALTER TABLE dashboard_projection_state ADD COLUMN fact_revision INTEGER CHECK(fact_revision>0);

ALTER TABLE dashboard_projection_state ADD COLUMN first_captured_at TEXT;

ALTER TABLE dashboard_projection_state ADD COLUMN time_zone TEXT CHECK(
 (fact_revision IS NULL AND first_captured_at IS NULL AND time_zone IS NULL)
 OR(fact_revision IS NOT NULL AND first_captured_at IS NOT NULL AND time_zone IS NOT NULL));

UPDATE dashboard_projection_state AS p SET(fact_revision,first_captured_at,time_zone)=
 (SELECT revision,first_captured_at,time_zone FROM transaction_fact_state f WHERE f.user_id=p.user_id)
WHERE EXISTS(SELECT 1 FROM transaction_fact_state f WHERE f.user_id=p.user_id);

-- A missing projection state remains unavailable until bounded repair completes.
INSERT INTO dashboard_projection_state(user_id,version,readiness,fact_revision,first_captured_at,time_zone)
SELECT user_id,0,'dirty',revision,first_captured_at,time_zone FROM transaction_fact_state f
WHERE NOT EXISTS(SELECT 1 FROM dashboard_projection_state p WHERE p.user_id=f.user_id);

DROP TABLE transaction_fact_state;

DROP TRIGGER erasure_preserve_dashboard_projection_state_delete;

CREATE TRIGGER transaction_fact_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO dashboard_projection_state(user_id,version,readiness,fact_revision,first_captured_at,time_zone)
  SELECT NEW.user_id,0,'dirty',1,NEW.created_at,time_zone FROM users WHERE id=NEW.user_id
  ON CONFLICT(user_id) DO UPDATE SET fact_revision=coalesce(fact_revision,0)+1,
    first_captured_at=coalesce(first_captured_at,excluded.first_captured_at),
    time_zone=coalesce(dashboard_projection_state.time_zone,excluded.time_zone);
END;

CREATE TRIGGER transaction_fact_update AFTER UPDATE ON transactions BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER transaction_fact_attestation AFTER INSERT ON source_attestations BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1,
    time_zone = CASE WHEN NEW.transaction_id = (SELECT id FROM transactions WHERE user_id = NEW.user_id ORDER BY created_at, id LIMIT 1)
      AND (SELECT count(*) FROM source_attestations WHERE user_id = NEW.user_id AND transaction_id = NEW.transaction_id) = 1
      THEN NEW.time_zone ELSE time_zone END
  WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER transaction_fact_link_insert AFTER INSERT ON transaction_reconciliation_decisions BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER transaction_fact_link_update AFTER UPDATE ON transaction_reconciliation_decisions BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = NEW.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER transaction_fact_delete AFTER DELETE ON transactions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transactions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = OLD.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER transaction_fact_link_delete AFTER DELETE ON transaction_reconciliation_decisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transaction_reconciliation_decisions' AND (OLD.user_id=q.user_id))
BEGIN
  UPDATE dashboard_projection_state SET fact_revision = fact_revision + 1 WHERE user_id = OLD.user_id AND fact_revision IS NOT NULL;
END;

CREATE TRIGGER erasure_fence_dashboard_projection_state_insert BEFORE INSERT ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_dashboard_projection_state_update BEFORE UPDATE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_dashboard_projection_state_delete BEFORE DELETE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='dashboard_projection_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_dashboard_projection_state_delete BEFORE DELETE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'version',OLD."version",'readiness',OLD."readiness",'cursor_id',OLD."cursor_id",'attempted_at_ms',OLD."attempted_at_ms",'fact_revision',OLD.fact_revision,'first_captured_at',OLD.first_captured_at,'time_zone',OLD.time_zone)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;
