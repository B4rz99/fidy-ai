CREATE TABLE ingestion_review_state (
  id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('pending','skipped','created')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  draft_json TEXT, transaction_id TEXT, expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
  CHECK ((status = 'created') = (transaction_id IS NOT NULL)),
  CHECK(draft_json IS NULL OR length(draft_json) <= 4096)
) STRICT;
CREATE INDEX ingestion_review_state_history ON ingestion_review_state(created_at_ms);
CREATE INDEX ingestion_review_state_expiry ON ingestion_review_state(expires_at_ms);

-- Older statement projections observe the same decisions without duplicating settlement writes.
CREATE VIEW ingestion_statement_review_decisions AS
SELECT r.id AS review_id,r.submission_id,r.user_id,
  CASE n.status WHEN 'created' THEN 'resolved' WHEN 'skipped' THEN 'skipped' END AS decision,
  n.transaction_id,n.updated_at_ms AS decided_at_ms
FROM statement_needs_review r JOIN ingestion_review_state n ON n.id=r.id AND n.user_id=r.user_id
WHERE n.status!='pending'
UNION ALL
SELECT d.review_id,d.submission_id,d.user_id,d.decision,d.transaction_id,d.decided_at_ms
FROM statement_review_decisions d WHERE NOT EXISTS
  (SELECT 1 FROM ingestion_review_state n WHERE n.id=d.review_id AND n.user_id=d.user_id);

