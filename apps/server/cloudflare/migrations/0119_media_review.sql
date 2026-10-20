-- Review metadata belongs to the accepted submission; absent legacy markers stay absent.
ALTER TABLE media_submissions ADD COLUMN review_reason TEXT CHECK(review_reason IN ('extraction-unavailable','unparseable-material'));

ALTER TABLE media_submissions ADD COLUMN review_created_at_ms INTEGER CHECK((review_reason IS NULL)=(review_created_at_ms IS NULL));

DROP TRIGGER IF EXISTS erasure_fence_media_submissions_update;

UPDATE media_submissions SET
 review_reason=(SELECT r.reason FROM media_needs_review r WHERE r.id=media_submissions.id AND r.user_id=media_submissions.user_id),
 review_created_at_ms=(SELECT r.created_at_ms FROM media_needs_review r WHERE r.id=media_submissions.id AND r.user_id=media_submissions.user_id);

DROP VIEW IF EXISTS ingestion_review_originals;

DROP TRIGGER IF EXISTS erasure_fence_media_needs_review_insert;
DROP TRIGGER IF EXISTS erasure_fence_media_needs_review_update;
DROP TRIGGER IF EXISTS erasure_fence_media_needs_review_delete;
DROP TRIGGER IF EXISTS erasure_preserve_media_needs_review_delete;

DROP TABLE media_needs_review;

CREATE INDEX media_review_user ON media_submissions(user_id,review_created_at_ms DESC,id DESC) WHERE review_reason IS NOT NULL;

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
SELECT s.id, s.user_id, 'media', s.review_reason, s.review_created_at_ms, s.expires_at_ms,
  s.service_market, s.locale, s.time_zone, NULL, 'pending', NULL
FROM media_submissions s WHERE s.review_reason IS NOT NULL;

CREATE TRIGGER erasure_fence_media_submissions_update BEFORE UPDATE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='media_submissions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

DROP TRIGGER IF EXISTS erasure_preserve_media_submissions_delete;

CREATE TRIGGER erasure_preserve_media_submissions_delete BEFORE DELETE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'message_id',OLD."message_id",'media_id',OLD."media_id",'caption',OLD."caption",'accepted_at_ms',OLD."accepted_at_ms",'expires_at_ms',OLD."expires_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'review_reason',OLD."review_reason",'review_created_at_ms',OLD."review_created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;
