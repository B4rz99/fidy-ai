DROP VIEW billing_retry_clearances;
--> statement-breakpoint

CREATE VIEW billing_retry_clearances AS
SELECT a.id AS attempt_id FROM billing_attempts a
JOIN billing_provider_transactions evidence ON evidence.attempt_id=a.id
WHERE a.status='failed' AND a.collection_state='sent'
  AND evidence.status='DECLINED' AND evidence.finalized_at_ms IS NOT NULL
  AND evidence.finalized_at_ms<=a.finalized_at_ms
  AND evidence.negative_observed_at_ms<=a.finalized_at_ms-180000
  AND (a.checkout_transaction_id IS NULL OR a.checkout_transaction_id=evidence.transaction_id)
  AND NOT EXISTS (SELECT 1 FROM billing_provider_transactions candidate
    WHERE candidate.attempt_id=a.id AND candidate.transaction_id<>evidence.transaction_id)
  AND a.paid_starts_at_ms IS NULL;
