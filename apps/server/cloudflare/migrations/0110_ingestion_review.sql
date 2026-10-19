
DROP TRIGGER statement_review_settlement_only;
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
  AND (NEW.status = OLD.status OR NEW.status = 'expired' OR EXISTS (SELECT 1 FROM statement_review_decisions
    WHERE review_id = OLD.id AND user_id = OLD.user_id AND decision = 'resolved')))
BEGIN SELECT RAISE(ABORT, 'review_immutable'); END;


-- A metadata projection leaves raw originals in their existing purpose-bound stores.
CREATE VIEW ingestion_review_originals AS
SELECT r.id, r.user_id, 'statement' AS source, r.reason, r.created_at_ms,
  r.evidence_expires_at_ms AS expires_at_ms, r.service_market, r.locale, r.time_zone, r.review_suggestions_json AS suggestions_json,
  CASE WHEN d.decision = 'resolved' THEN 'created'
    WHEN d.decision = 'skipped' THEN 'skipped'
    WHEN d.decision = 'abandoned' THEN 'expired'
    ELSE 'pending' END AS status, d.transaction_id
FROM statement_needs_review r LEFT JOIN statement_review_decisions d
  ON d.review_id = r.id AND d.user_id = r.user_id
UNION ALL
SELECT r.id, r.user_id, 'email', r.reason, r.created_at_ms, r.evidence_expires_at_ms,
  'CO', 'es-CO', s.time_zone, NULL, 'pending', NULL
FROM forwarded_email_needs_review r JOIN forwarded_email_receipts s
  ON s.id = r.receipt_id AND s.user_id = r.user_id
UNION ALL
SELECT r.id, r.user_id, 'media', r.reason, r.created_at_ms, s.expires_at_ms,
  s.service_market, s.locale, s.time_zone, NULL, 'pending', NULL
FROM media_needs_review r JOIN media_submissions s ON s.id = r.id AND s.user_id = r.user_id;
CREATE TABLE ingestion_review_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;

CREATE VIEW ingestion_review_sources AS
SELECT s.id,s.user_id,s.source,s.reason,s.created_at_ms,s.expires_at_ms,s.service_market,s.locale,s.time_zone,
  CASE WHEN s.status = 'created' THEN 'created' ELSE coalesce(d.status,s.status) END AS status,coalesce(d.transaction_id,s.transaction_id) AS transaction_id,
  coalesce(d.revision,0) AS revision,d.draft_json,s.suggestions_json
FROM ingestion_review_originals s LEFT JOIN ingestion_review_state d ON d.id=s.id AND d.user_id=s.user_id;

ALTER TABLE source_attestations ADD COLUMN review_item_id TEXT;
ALTER TABLE source_attestations ADD COLUMN user_provided_fields TEXT;
CREATE UNIQUE INDEX source_attestation_review_item ON source_attestations(user_id,review_item_id) WHERE review_item_id IS NOT NULL;
CREATE TRIGGER ingestion_review_legacy_guard BEFORE INSERT ON statement_review_decisions
WHEN EXISTS (SELECT 1 FROM ingestion_review_state WHERE id=NEW.review_id AND user_id=NEW.user_id AND status IN ('created','skipped'))
BEGIN SELECT RAISE(ABORT,'statement_decision_unavailable'); END;

-- Conversation routing expires independently from the ingestion review purpose.
DROP TRIGGER statement_extraction_clarification;
CREATE TRIGGER statement_extraction_clarification AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed') AND OLD.status IN ('queued','processing') AND NEW.needs_review_rows > 0
BEGIN
  INSERT INTO statement_clarifications(submission_id,user_id,state,expires_at_ms)
    SELECT NEW.id,NEW.user_id,'awaiting',min(evidence_expires_at_ms)
    FROM statement_needs_review WHERE submission_id=NEW.id;
  UPDATE statement_clarifications SET state='abandoned',ended_at_ms=NEW.completed_at_ms
    WHERE submission_id=NEW.id AND expires_at_ms <= NEW.completed_at_ms;
END;
DROP TRIGGER statement_decision_settlement;
CREATE TRIGGER statement_decision_settlement AFTER INSERT ON statement_review_decisions
BEGIN
  UPDATE statement_needs_review SET status=CASE WHEN NEW.decision='resolved' THEN 'resolved' ELSE 'expired' END,
    original_evidence=NULL,known_money=NULL,review_suggestions_json=NULL WHERE id=NEW.review_id AND status='pending' AND NEW.decision!='skipped';
  UPDATE statement_backfill_entitlements SET consumed_at_ms=coalesce(consumed_at_ms,NEW.decided_at_ms)
    WHERE user_id=NEW.user_id AND submission_id=NEW.submission_id AND NEW.decision='resolved';
  UPDATE statement_clarifications SET state='completed',ended_at_ms=NEW.decided_at_ms
    WHERE submission_id=NEW.submission_id AND state='awaiting'
      AND NOT EXISTS(SELECT 1 FROM statement_needs_review r WHERE r.submission_id=NEW.submission_id
        AND NOT EXISTS(SELECT 1 FROM statement_review_decisions d WHERE d.review_id=r.id));
  UPDATE statement_backfill_entitlements SET submission_id=NULL
    WHERE user_id=NEW.user_id AND submission_id=NEW.submission_id AND consumed_at_ms IS NULL
      AND EXISTS(SELECT 1 FROM statement_clarifications WHERE submission_id=NEW.submission_id AND state!='awaiting');
END;

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

-- Inbox decisions settle independently; expiry must not attempt a second legacy decision.
DROP TRIGGER statement_clarification_abandon;
CREATE TRIGGER statement_clarification_abandon AFTER UPDATE OF state ON statement_clarifications
WHEN NEW.state='abandoned'
BEGIN
  INSERT INTO statement_review_decisions(review_id,submission_id,user_id,decision,decided_at_ms)
  SELECT id,submission_id,user_id,'abandoned',NEW.ended_at_ms FROM statement_needs_review r
  WHERE submission_id=NEW.submission_id
    AND NOT EXISTS(SELECT 1 FROM statement_review_decisions d WHERE d.review_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM ingestion_review_state n WHERE n.id=r.id AND n.user_id=r.user_id);
  UPDATE statement_backfill_entitlements SET submission_id=NULL
    WHERE user_id=NEW.user_id AND submission_id=NEW.submission_id AND consumed_at_ms IS NULL;
END;
