DROP TRIGGER IF EXISTS statement_decision_guard;

DROP TRIGGER IF EXISTS statement_decision_immutable;

DROP TRIGGER IF EXISTS statement_clarification_transition;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_decisions_insert;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_decisions_update;

DROP TRIGGER IF EXISTS erasure_fence_statement_review_decisions_delete;

DROP TRIGGER IF EXISTS erasure_preserve_statement_review_decisions_delete;

DROP VIEW ingestion_statement_review_decisions;

DROP TRIGGER IF EXISTS statement_review_settlement_only;

DROP VIEW ingestion_review_originals;

DROP VIEW ingestion_review_sources;

DROP TRIGGER IF EXISTS ingestion_review_legacy_guard;

DROP TRIGGER IF EXISTS statement_decision_settlement;

DROP TRIGGER IF EXISTS reviewed_statement_entitlement_insert;

DROP TRIGGER IF EXISTS reviewed_statement_entitlement_update;

DROP TRIGGER IF EXISTS statement_clarification_abandon;

DROP TRIGGER IF EXISTS erasure_fence_ingestion_review_state_insert;

DROP TRIGGER IF EXISTS erasure_fence_ingestion_review_state_update;

DROP TRIGGER IF EXISTS erasure_fence_ingestion_review_state_delete;

DROP TRIGGER IF EXISTS erasure_preserve_ingestion_review_state_delete;

DROP TRIGGER IF EXISTS erasure_preserve_ingestion_review_state_update;

CREATE TABLE ingestion_review_state_next (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending','skipped','created','abandoned')),
 revision INTEGER NOT NULL CHECK(revision > 0), draft_json TEXT, transaction_id TEXT,
 expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id,id), FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
 CHECK((status='created')=(transaction_id IS NOT NULL)),
 CHECK(draft_json IS NULL OR length(draft_json)<=4096)
) STRICT;

INSERT INTO ingestion_review_state_next SELECT * FROM ingestion_review_state;

INSERT INTO ingestion_review_state_next (id,user_id,status,revision,transaction_id,expires_at_ms,updated_at_ms,created_at_ms)
 SELECT d.review_id,d.user_id,CASE d.decision WHEN 'resolved' THEN 'created' ELSE d.decision END,1,
 d.transaction_id,r.evidence_expires_at_ms,d.decided_at_ms,r.created_at_ms
 FROM statement_review_decisions d JOIN statement_needs_review r ON r.id=d.review_id AND r.user_id=d.user_id
 WHERE NOT EXISTS(SELECT 1 FROM ingestion_review_state n WHERE n.id=d.review_id AND n.user_id=d.user_id)
 OR d.decision='resolved'
 ON CONFLICT(user_id,id) DO UPDATE SET status=excluded.status,transaction_id=excluded.transaction_id;

DROP TABLE statement_review_decisions;

DROP TABLE ingestion_review_state;

CREATE TABLE ingestion_review_state (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('pending','skipped','created','abandoned')),
 revision INTEGER NOT NULL CHECK(revision > 0), draft_json TEXT, transaction_id TEXT,
 expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id,id), FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
 CHECK((status='created')=(transaction_id IS NOT NULL)),
 CHECK(draft_json IS NULL OR length(draft_json)<=4096)
) STRICT;

INSERT INTO ingestion_review_state SELECT * FROM ingestion_review_state_next;
DROP TABLE ingestion_review_state_next;

CREATE INDEX ingestion_review_state_history ON ingestion_review_state(created_at_ms);

CREATE INDEX ingestion_review_state_expiry ON ingestion_review_state(expires_at_ms);

CREATE TRIGGER statement_review_settlement_only BEFORE UPDATE ON statement_needs_review
WHEN NOT (((OLD.status = 'pending' AND NEW.status IN ('expired', 'resolved')
  AND NEW.original_evidence IS NULL AND NEW.known_money IS NULL) OR
  (NEW.status=OLD.status AND NEW.original_evidence IS OLD.original_evidence AND NEW.known_money IS OLD.known_money
    AND NEW.review_suggestions_json IS NULL))
  AND NEW.id = OLD.id AND NEW.user_id = OLD.user_id
  AND NEW.submission_id = OLD.submission_id AND NEW.record_number = OLD.record_number
  AND NEW.reason = OLD.reason AND NEW.issues = OLD.issues
  AND NEW.evidence_expires_at_ms = OLD.evidence_expires_at_ms
  AND NEW.created_at_ms = OLD.created_at_ms AND NEW.service_market = OLD.service_market
  AND NEW.locale = OLD.locale AND NEW.time_zone = OLD.time_zone
  AND NEW.source_format = OLD.source_format AND NEW.parser_revision = OLD.parser_revision
  AND NEW.extractor_revision = OLD.extractor_revision
  AND (NEW.status = OLD.status OR NEW.status = 'expired' OR EXISTS (SELECT 1 FROM ingestion_review_state
    WHERE id = OLD.id AND user_id = OLD.user_id AND status = 'created')))
BEGIN SELECT RAISE(ABORT, 'review_immutable'); END;

CREATE VIEW ingestion_review_originals AS
SELECT r.id, r.user_id, 'statement' AS source, r.reason, r.created_at_ms,
  r.evidence_expires_at_ms AS expires_at_ms, r.service_market, r.locale, r.time_zone, r.review_suggestions_json AS suggestions_json,
  'pending' AS status, NULL AS transaction_id
FROM statement_needs_review r
UNION ALL
SELECT r.id, r.user_id, 'email', r.reason, r.created_at_ms, r.evidence_expires_at_ms,
  'CO', 'es-CO', s.time_zone, NULL, 'pending', NULL
FROM forwarded_email_needs_review r JOIN forwarded_email_receipts s
  ON s.id = r.receipt_id AND s.user_id = r.user_id
UNION ALL
SELECT r.id, r.user_id, 'media', r.reason, r.created_at_ms, s.expires_at_ms,
  s.service_market, s.locale, s.time_zone, NULL, 'pending', NULL
FROM media_needs_review r JOIN media_submissions s ON s.id = r.id AND s.user_id = r.user_id;

CREATE VIEW ingestion_review_sources AS
SELECT s.id,s.user_id,s.source,s.reason,s.created_at_ms,s.expires_at_ms,s.service_market,s.locale,s.time_zone,
  CASE WHEN d.status='abandoned' THEN 'expired' ELSE coalesce(d.status,s.status) END AS status,coalesce(d.transaction_id,s.transaction_id) AS transaction_id,
  coalesce(d.revision,0) AS revision,d.draft_json,s.suggestions_json
FROM ingestion_review_originals s LEFT JOIN ingestion_review_state d ON d.id=s.id AND d.user_id=s.user_id;

CREATE TRIGGER reviewed_statement_entitlement_insert AFTER INSERT ON ingestion_review_state
WHEN NEW.status='created'
BEGIN
  UPDATE statement_backfill_entitlements SET consumed_at_ms=coalesce(consumed_at_ms,NEW.updated_at_ms)
  WHERE user_id=NEW.user_id AND submission_id=(SELECT submission_id FROM statement_needs_review WHERE id=NEW.id AND user_id=NEW.user_id);
END;

CREATE TRIGGER reviewed_statement_entitlement_update AFTER UPDATE OF status ON ingestion_review_state
WHEN NEW.status='created' AND OLD.status!='created'
BEGIN
  UPDATE statement_backfill_entitlements SET consumed_at_ms=coalesce(consumed_at_ms,NEW.updated_at_ms)
  WHERE user_id=NEW.user_id AND submission_id=(SELECT submission_id FROM statement_needs_review WHERE id=NEW.id AND user_id=NEW.user_id);
END;

CREATE TRIGGER erasure_fence_ingestion_review_state_insert BEFORE INSERT ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_review_state_update BEFORE UPDATE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_ingestion_review_state_delete BEFORE DELETE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='ingestion_review_state'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_ingestion_review_state_delete BEFORE DELETE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."status",'revision',OLD."revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."expires_at_ms",'updated_at_ms',OLD."updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_ingestion_review_state_update BEFORE UPDATE ON ingestion_review_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
 INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
 SELECT q.id,'ingestion_review_state','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'status',OLD."status",'revision',OLD."revision",'draft_json',OLD."draft_json",'transaction_id',OLD."transaction_id",'expires_at_ms',OLD."expires_at_ms",'updated_at_ms',OLD."updated_at_ms",'created_at_ms',OLD."created_at_ms")
 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id
 AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
 AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE VIEW ingestion_statement_review_decisions AS
SELECT r.id AS review_id,r.submission_id,r.user_id,
 CASE n.status WHEN 'created' THEN 'resolved' ELSE n.status END AS decision,
 n.transaction_id,n.updated_at_ms AS decided_at_ms
FROM statement_needs_review r JOIN ingestion_review_state n ON n.id=r.id AND n.user_id=r.user_id
WHERE n.status!='pending';

CREATE TRIGGER statement_clarification_transition BEFORE UPDATE OF state ON statement_clarifications
WHEN NOT ((NEW.state=OLD.state AND NEW.ended_at_ms IS OLD.ended_at_ms)
 OR (OLD.state='awaiting' AND NEW.state IN ('completed','abandoned') AND NEW.ended_at_ms IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'statement_clarification_terminal'); END;

CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF state ON statement_clarifications
WHEN NEW.state='abandoned'
BEGIN
 INSERT INTO ingestion_review_state(id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms)
 SELECT r.id,r.user_id,'abandoned',1,r.evidence_expires_at_ms,NEW.ended_at_ms,r.created_at_ms
 FROM statement_needs_review r WHERE r.submission_id=NEW.submission_id
 AND NOT EXISTS(SELECT 1 FROM ingestion_review_state n WHERE n.id=r.id AND n.user_id=r.user_id AND n.status!='pending')
 ON CONFLICT(user_id,id) DO UPDATE SET status='abandoned',revision=revision+1,draft_json=NULL,updated_at_ms=excluded.updated_at_ms;
 UPDATE statement_needs_review SET status='expired',original_evidence=NULL,known_money=NULL,review_suggestions_json=NULL
 WHERE submission_id=NEW.submission_id AND status='pending' AND EXISTS
 (SELECT 1 FROM ingestion_review_state n WHERE n.id=statement_needs_review.id AND n.user_id=NEW.user_id AND n.status='abandoned');
 UPDATE statement_backfill_entitlements SET submission_id=NULL
 WHERE user_id=NEW.user_id AND submission_id=NEW.submission_id AND consumed_at_ms IS NULL;
END;

CREATE TRIGGER statement_clarification_release AFTER UPDATE OF state ON statement_clarifications
WHEN NEW.state='completed'
BEGIN
 UPDATE statement_backfill_entitlements SET submission_id=NULL
 WHERE user_id=NEW.user_id AND submission_id=NEW.submission_id AND consumed_at_ms IS NULL;
END;
