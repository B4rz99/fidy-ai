CREATE INDEX ingestion_review_pending_page ON ingestion_review_items(
  -- Match ingestion_review_sources.status for live pending count and ordered page seeks.
  user_id,
  CASE WHEN workspace_state='abandoned' THEN 'expired' ELSE coalesce(workspace_state,'pending') END,
  evidence_expires_at_ms,
  id
);
