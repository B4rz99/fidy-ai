-- A cleared failed card may be replaced by any enabled enrollment method.
-- Retain every source/attempt identity and never infer absence of charge from failure alone.
DROP TRIGGER card_source_immutable;
CREATE TRIGGER card_source_immutable BEFORE UPDATE ON card_payment_sources
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.enrollment_id<>OLD.enrollment_id
  OR NEW.wompi_source_id<>OLD.wompi_source_id OR NEW.billing_email<>OLD.billing_email
  OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.method<>OLD.method
  OR OLD.retired_at_ms IS NOT NULL OR NEW.retired_at_ms IS NULL
  OR OLD.method<>'card'
  OR NOT EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id)
  OR EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.user_id=OLD.user_id)
  OR EXISTS (SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=OLD.id
    AND (a.status<>'failed'
      OR EXISTS (SELECT 1 FROM billing_transaction_evidence e WHERE e.attempt_id=a.id AND e.status IN ('PENDING','APPROVED'))
      OR (NOT EXISTS (SELECT 1 FROM billing_retry_clearances clear WHERE clear.attempt_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations clear
          WHERE clear.attempt_id=a.id AND clear.wompi_reference=a.wompi_reference
            AND clear.wompi_environment=a.wompi_environment))))
BEGIN SELECT RAISE(ABORT, 'card_source_immutable'); END;
