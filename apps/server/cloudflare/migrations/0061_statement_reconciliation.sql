-- Reconciliation rotates its bounded scan independently of Queue delivery cooldown claims.
-- Missing or unavailable Workflow lookups must never postpone an unoffered/retryable identity.
ALTER TABLE statement_ingestion_outbox ADD COLUMN last_reconciled_at_ms INTEGER
  CHECK (last_reconciled_at_ms IS NULL OR last_reconciled_at_ms >= 0);
CREATE INDEX statement_ingestion_outbox_reconciliation
  ON statement_ingestion_outbox(last_reconciled_at_ms, published_at_ms, submission_id);
