WITH material(source, seen, attention) AS (
  SELECT 'structural_samples', count(*), count(*)
  FROM (SELECT 1 FROM anonymized_email_samples LIMIT 1001)
  UNION ALL
  SELECT 'issued_r2_writers', count(*), count(*)
  FROM (SELECT 1 FROM erasure_writers LIMIT 1001)
  UNION ALL
  SELECT 'forwarded_email_receipts', count(*),
         count(*) FILTER (WHERE state = 'storing' OR (state = 'queued' AND outcome_completed_at_ms IS NULL))
  FROM (SELECT state, outcome_completed_at_ms FROM forwarded_email_receipts LIMIT 1001)
  UNION ALL
  SELECT 'statement_staging', count(*), count(*) FILTER (WHERE object_deleted_at_ms IS NULL)
  FROM (SELECT object_deleted_at_ms FROM statement_staging_objects LIMIT 1001)
  UNION ALL
  SELECT 'upload_admission_events', count(*), count(*) FILTER (WHERE released_at_epoch_ms IS NULL)
  FROM (
    SELECT released_at_epoch_ms FROM resource_admission_events
    WHERE policy_key = 'ingestion.upload.outstanding.v1' LIMIT 1001
  )
),
billing(source, seen, attention) AS (
  SELECT 'wompi_callback_candidates', count(*),
         count(*) FILTER (WHERE event_received_at_ms IS NOT NULL AND event_resolved_at_ms IS NULL)
  FROM (SELECT event_received_at_ms, event_resolved_at_ms FROM billing_provider_transactions LIMIT 1001)
  UNION ALL
  SELECT 'billing_attempts', count(*), count(*) FILTER (WHERE status = 'pending' OR (status = 'failed' AND collection_state = 'sent')
                          OR late_approval_observed_at_ms IS NOT NULL)
  FROM (SELECT status, collection_state, late_approval_observed_at_ms FROM billing_attempts LIMIT 1001)
  UNION ALL
  SELECT 'refund_attempts', count(*), count(*) FILTER (WHERE status = 'pending')
  FROM (SELECT status FROM refund_attempts LIMIT 1001)
  UNION ALL
  SELECT 'payment_enrollments', count(*), count(*) FILTER (WHERE status IN ('creating', 'verifying'))
  FROM (SELECT status FROM payment_enrollments LIMIT 1001)
),
delivery(source, seen, attention) AS (
  SELECT 'whatsapp_deliveries', count(*),
         count(*) FILTER (WHERE state IN ('ready', 'staged', 'sending', 'accepted', 'ambiguous', 'unconfirmed'))
  FROM (SELECT state FROM whatsapp_deliveries LIMIT 1001)
  UNION ALL
  SELECT 'connection_attempts', count(*), count(*) FILTER (WHERE status = 'pending')
  FROM (SELECT status FROM connection_attempts LIMIT 1001)
  UNION ALL
  SELECT 'provider_authentication_attempts', count(*), count(*) FILTER (WHERE state IN ('pending', 'exchanging', 'verified'))
  FROM (SELECT state FROM provider_authentication_attempts LIMIT 1001)
),
inventory AS (
  SELECT * FROM material
  UNION ALL SELECT * FROM billing
  UNION ALL SELECT * FROM delivery
)
SELECT source, min(seen, 1000) AS rows_up_to_limit, seen <= 1000 AS complete,
       CASE WHEN seen <= 1000 THEN attention END AS attention_rows
FROM inventory;
