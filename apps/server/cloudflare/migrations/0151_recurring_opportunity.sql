PRAGMA defer_foreign_keys=ON;

DROP TRIGGER erasure_fence_recurring_digest_opportunities_insert;

DROP TRIGGER erasure_fence_recurring_digest_opportunities_update;

DROP TRIGGER erasure_fence_recurring_digest_opportunities_delete;

DROP TRIGGER erasure_preserve_recurring_digest_opportunities_delete;

ALTER TABLE proactivity_offer_requests ADD COLUMN current_recurring_opportunity INTEGER CHECK(current_recurring_opportunity IS NULL OR (current_recurring_opportunity=1 AND kind='new-recurring-series'));

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_recurring_opportunity',NOT EXISTS(SELECT 1 FROM recurring_digest_opportunities o WHERE NOT EXISTS(SELECT 1 FROM proactivity_offer_requests q WHERE q.user_id=o.user_id AND q.id=o.request_id AND q.kind='new-recurring-series'));

UPDATE proactivity_offer_requests SET current_recurring_opportunity=1 WHERE EXISTS(SELECT 1 FROM recurring_digest_opportunities o WHERE o.user_id=proactivity_offer_requests.user_id AND o.request_id=proactivity_offer_requests.id);

CREATE UNIQUE INDEX recurring_current_opportunity ON proactivity_offer_requests(user_id) WHERE current_recurring_opportunity=1;

CREATE TRIGGER recurring_opportunity_erasure_insert BEFORE INSERT ON proactivity_offer_requests WHEN (NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER recurring_opportunity_erasure_update BEFORE UPDATE ON proactivity_offer_requests WHEN (NEW.current_recurring_opportunity IS NOT OLD.current_recurring_opportunity) AND ((OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))) OR (NEW.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities')))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER recurring_opportunity_erasure_delete BEFORE DELETE ON proactivity_offer_requests WHEN (OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_opportunities'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

DROP TABLE recurring_digest_opportunities;

DELETE FROM sql_assertions WHERE scope='migration_recurring_opportunity';

PRAGMA defer_foreign_keys=OFF;

DROP TRIGGER erasure_fence_proactivity_offer_requests_update;
CREATE TRIGGER erasure_fence_proactivity_offer_requests_update BEFORE UPDATE ON proactivity_offer_requests
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_offer_requests')) AND NOT(NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.kind IS OLD.kind AND NEW.request_message_id IS OLD.request_message_id AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.materialized_at_ms IS OLD.materialized_at_ms AND NEW.last_evaluated_at_ms IS OLD.last_evaluated_at_ms AND NEW.delivery_id IS OLD.delivery_id)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
CREATE TRIGGER recurring_opportunity_preserve_update BEFORE UPDATE ON proactivity_offer_requests
WHEN OLD.current_recurring_opportunity=1 AND NEW.current_recurring_opportunity IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
CREATE TRIGGER recurring_opportunity_preserve_delete BEFORE DELETE ON proactivity_offer_requests
WHEN OLD.current_recurring_opportunity=1 AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.user_id,'request_id',OLD.id)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
