PRAGMA defer_foreign_keys=ON;

DROP TRIGGER statement_backfill_on_capture;

DROP TRIGGER erasure_fence_statement_backfill_entitlements_insert;

DROP TRIGGER erasure_fence_statement_backfill_entitlements_update;

DROP TRIGGER erasure_fence_statement_backfill_entitlements_delete;

DROP TRIGGER erasure_preserve_statement_backfill_entitlements_delete;

DROP TRIGGER reviewed_statement_entitlement_insert;

DROP TRIGGER reviewed_statement_entitlement_update;

DROP TRIGGER statement_partial_backfill_on_failure;

DROP TRIGGER statement_clarification_abandon;

DROP TRIGGER statement_clarification_release;

ALTER TABLE users ADD COLUMN backfill_present INTEGER CHECK(backfill_present IS NULL OR backfill_present=1);

ALTER TABLE users ADD COLUMN backfill_submission_id TEXT REFERENCES statement_submissions(id);

ALTER TABLE users ADD COLUMN backfill_consumed_at_ms INTEGER CHECK(backfill_consumed_at_ms IS NULL OR backfill_consumed_at_ms>=0) CHECK(backfill_present IS NOT NULL OR (backfill_submission_id IS NULL AND backfill_consumed_at_ms IS NULL));

UPDATE users SET backfill_present=1,backfill_submission_id=e.submission_id,backfill_consumed_at_ms=e.consumed_at_ms FROM statement_backfill_entitlements e WHERE e.user_id=users.id;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_backfill',((SELECT count(*) FROM statement_backfill_entitlements)=(SELECT count(*) FROM users WHERE backfill_present IS NOT NULL)) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE statement_backfill_entitlements;

CREATE INDEX users_backfill_submission ON users(backfill_submission_id) WHERE backfill_submission_id IS NOT NULL;

CREATE TRIGGER statement_backfill_on_capture AFTER INSERT ON statement_record_outcomes
WHEN NEW.outcome = 'accepted'
BEGIN
  UPDATE users
    SET backfill_consumed_at_ms = coalesce(backfill_consumed_at_ms, unixepoch('now') * 1000)
    WHERE backfill_present IS NOT NULL AND id = NEW.user_id AND backfill_submission_id = NEW.submission_id;
END;

CREATE TRIGGER reviewed_statement_entitlement_insert AFTER INSERT ON ingestion_review_state
WHEN NEW.status='created'
BEGIN
  UPDATE users SET backfill_consumed_at_ms=coalesce(backfill_consumed_at_ms,NEW.updated_at_ms)
  WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=(SELECT submission_id FROM statement_needs_review WHERE id=NEW.id AND user_id=NEW.user_id);
END;

CREATE TRIGGER reviewed_statement_entitlement_update AFTER UPDATE OF status ON ingestion_review_state
WHEN NEW.status='created' AND OLD.status!='created'
BEGIN
  UPDATE users SET backfill_consumed_at_ms=coalesce(backfill_consumed_at_ms,NEW.updated_at_ms)
  WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=(SELECT submission_id FROM statement_needs_review WHERE id=NEW.id AND user_id=NEW.user_id);
END;

CREATE TRIGGER statement_partial_backfill_on_failure AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status = 'failed' AND OLD.status IN ('queued', 'processing')
BEGIN
 UPDATE users
    SET backfill_submission_id = CASE WHEN backfill_consumed_at_ms IS NULL THEN NULL ELSE backfill_submission_id END
    WHERE backfill_present IS NOT NULL AND id = NEW.user_id AND backfill_submission_id = NEW.id;
END;

CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='abandoned'
BEGIN
 INSERT INTO ingestion_review_state(id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms)
 SELECT r.id,r.user_id,'abandoned',1,r.evidence_expires_at_ms,NEW.clarification_ended_at_ms,r.created_at_ms
 FROM statement_needs_review r WHERE r.submission_id=NEW.id
 AND NOT EXISTS(SELECT 1 FROM ingestion_review_state n WHERE n.id=r.id AND n.user_id=r.user_id AND n.status!='pending')
 ON CONFLICT(user_id,id) DO UPDATE SET status='abandoned',revision=revision+1,draft_json=NULL,updated_at_ms=excluded.updated_at_ms;
 UPDATE statement_needs_review SET status='expired',original_evidence=NULL,known_money=NULL,review_suggestions_json=NULL
 WHERE submission_id=NEW.id AND status='pending' AND EXISTS
 (SELECT 1 FROM ingestion_review_state n WHERE n.id=statement_needs_review.id AND n.user_id=NEW.user_id AND n.status='abandoned');
 UPDATE users SET backfill_submission_id=NULL
 WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.id AND backfill_consumed_at_ms IS NULL;
END;

CREATE TRIGGER statement_clarification_release AFTER UPDATE OF clarification_state ON statement_submissions
WHEN NEW.clarification_state='completed'
BEGIN
 UPDATE users SET backfill_submission_id=NULL
 WHERE backfill_present IS NOT NULL AND id=NEW.user_id AND backfill_submission_id=NEW.id AND backfill_consumed_at_ms IS NULL;
END;

CREATE TRIGGER statement_backfill_entitlements_field_fence_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_backfill_entitlements_field_fence_update BEFORE UPDATE ON users WHEN (NEW.backfill_present IS NOT OLD.backfill_present OR NEW.backfill_submission_id IS NOT OLD.backfill_submission_id OR NEW.backfill_consumed_at_ms IS NOT OLD.backfill_consumed_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.id=q.user_id AND NEW.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_backfill_entitlements_field_fence_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.id=q.user_id AND OLD.backfill_present IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_backfill_entitlements')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_backfill_entitlements_field_preserve_update BEFORE UPDATE ON users WHEN OLD.backfill_present IS NOT NULL AND NEW.backfill_present IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_backfill_entitlements','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'submission_id',OLD.backfill_submission_id,'consumed_at_ms',OLD.backfill_consumed_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER statement_backfill_entitlements_field_preserve_delete BEFORE DELETE ON users WHEN OLD.backfill_present IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_backfill_entitlements','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'submission_id',OLD.backfill_submission_id,'consumed_at_ms',OLD.backfill_consumed_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;
