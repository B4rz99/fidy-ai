import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Splits one BillingAttempt's provider identity into the transactions Wompi actually collects under
 * its one checkout reference. `billing_attempts.wompi_transaction_id` could only retain the first
 * transaction Wompi created, so a declined first transaction hid any retry under the same
 * reference. Each provider transaction now keeps its own absorbing current state in
 * `billing_attempt_transactions`; `wompi_billing_observations` stays the append-only evidence that
 * produced it. Existing rows are folded in before the single-identity column is dropped.
 */
export const wompiBillingTransactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE billing_attempt_transactions (
      billing_attempt_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wompi_transaction_id text NOT NULL UNIQUE,
      status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')),
      amount_in_cents bigint NOT NULL CHECK (amount_in_cents > 0),
      currency text NOT NULL,
      wompi_source_id bigint NOT NULL CHECK (wompi_source_id > 0),
      wompi_environment text NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
      finalized_at timestamptz,
      first_observed_at timestamptz NOT NULL,
      last_observed_at timestamptz NOT NULL,
      CHECK (last_observed_at >= first_observed_at),
      PRIMARY KEY (billing_attempt_id, wompi_transaction_id),
      FOREIGN KEY (billing_attempt_id, user_id) REFERENCES billing_attempts(id, user_id)
    );

    CREATE FUNCTION fidy_preserve_billing_transaction() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Billing transaction history is immutable'; END IF;
      IF NEW.billing_attempt_id IS DISTINCT FROM OLD.billing_attempt_id OR
         NEW.user_id IS DISTINCT FROM OLD.user_id OR
         NEW.wompi_transaction_id IS DISTINCT FROM OLD.wompi_transaction_id OR
         NEW.amount_in_cents IS DISTINCT FROM OLD.amount_in_cents OR
         NEW.currency IS DISTINCT FROM OLD.currency OR
         NEW.wompi_source_id IS DISTINCT FROM OLD.wompi_source_id OR
         NEW.wompi_environment IS DISTINCT FROM OLD.wompi_environment OR
         NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at
      THEN RAISE EXCEPTION 'Billing transaction fact is immutable'; END IF;
      IF OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED' THEN
        RAISE EXCEPTION 'approved Billing transaction cannot be downgraded';
      END IF;
      IF OLD.status IN ('DECLINED', 'VOIDED', 'ERROR')
         AND NEW.status NOT IN (OLD.status, 'APPROVED') THEN
        RAISE EXCEPTION 'settled Billing transaction cannot be reopened';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER billing_transaction_preserve
      BEFORE UPDATE OR DELETE ON billing_attempt_transactions
      FOR EACH ROW EXECUTE FUNCTION fidy_preserve_billing_transaction();

    ALTER TABLE billing_attempt_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE billing_attempt_transactions FORCE ROW LEVEL SECURITY;
    CREATE POLICY billing_attempt_transactions_by_user ON billing_attempt_transactions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    WITH observed AS (
      SELECT billing_attempt_id, user_id, wompi_transaction_id,
        bool_or(status = 'APPROVED') AS approved,
        bool_or(status = 'PENDING') AS pending,
        (array_agg(status ORDER BY observed_at DESC, id))[1] AS latest_status,
        (array_agg(amount_in_cents ORDER BY observed_at DESC, id))[1] AS amount_in_cents,
        (array_agg(currency ORDER BY observed_at DESC, id))[1] AS currency,
        (array_agg(wompi_source_id ORDER BY observed_at DESC, id))[1] AS wompi_source_id,
        (array_agg(wompi_environment ORDER BY observed_at DESC, id))[1] AS wompi_environment,
        (array_agg(finalized_at ORDER BY observed_at DESC, id))[1] AS finalized_at,
        min(observed_at) AS first_observed_at,
        max(observed_at) AS last_observed_at
      FROM wompi_billing_observations
      GROUP BY billing_attempt_id, user_id, wompi_transaction_id
    )
    INSERT INTO billing_attempt_transactions (
      billing_attempt_id, user_id, wompi_transaction_id, status, amount_in_cents, currency,
      wompi_source_id, wompi_environment, finalized_at, first_observed_at, last_observed_at
    )
    SELECT billing_attempt_id, user_id, wompi_transaction_id,
      CASE WHEN approved THEN 'APPROVED' WHEN pending THEN 'PENDING' ELSE latest_status END,
      amount_in_cents, currency, wompi_source_id, wompi_environment, finalized_at,
      first_observed_at, last_observed_at
    FROM observed;

    INSERT INTO billing_attempt_transactions (
      billing_attempt_id, user_id, wompi_transaction_id, status, amount_in_cents, currency,
      wompi_source_id, wompi_environment, finalized_at, first_observed_at, last_observed_at
    )
    SELECT attempt.id, attempt.user_id, attempt.wompi_transaction_id,
      CASE attempt.status
        WHEN 'succeeded' THEN 'APPROVED'
        WHEN 'failed' THEN 'DECLINED'
        ELSE 'PENDING'
      END,
      (attempt.amount * 100)::bigint, attempt.currency, source.wompi_source_id,
      attempt.wompi_environment,
      CASE WHEN attempt.status = 'succeeded' THEN attempt.finalized_at END,
      attempt.created_at, attempt.created_at
    FROM billing_attempts AS attempt
    INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
    WHERE attempt.wompi_transaction_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    CREATE OR REPLACE FUNCTION fidy_preserve_billing_snapshot() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BillingAttempt history is immutable'; END IF;
      IF NEW.user_id IS DISTINCT FROM OLD.user_id OR
         NEW.subscription_id IS DISTINCT FROM OLD.subscription_id OR
         NEW.payment_request_id IS DISTINCT FROM OLD.payment_request_id OR
         NEW.card_enrollment_id IS DISTINCT FROM OLD.card_enrollment_id OR
         NEW.payment_source_id IS DISTINCT FROM OLD.payment_source_id OR
         NEW.price_id IS DISTINCT FROM OLD.price_id OR
         NEW.amount IS DISTINCT FROM OLD.amount OR
         NEW.currency IS DISTINCT FROM OLD.currency OR
         NEW.billing_period IS DISTINCT FROM OLD.billing_period OR
         NEW.service_market IS DISTINCT FROM OLD.service_market OR
         NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR
         NEW.time_zone IS DISTINCT FROM OLD.time_zone OR
         NEW.wompi_environment IS DISTINCT FROM OLD.wompi_environment OR
         NEW.wompi_transaction_reference IS DISTINCT FROM OLD.wompi_transaction_reference OR
         NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN RAISE EXCEPTION 'BillingAttempt snapshot is immutable'; END IF;
      IF OLD.status = 'succeeded' AND NEW.status <> 'succeeded' THEN
        RAISE EXCEPTION 'successful BillingAttempt cannot be downgraded';
      END IF;
      IF OLD.status = 'failed' AND NEW.status = 'pending' THEN
        RAISE EXCEPTION 'failed BillingAttempt cannot return to pending';
      END IF;
      IF OLD.charge_state = 'armed' AND NEW.charge_state <> 'armed' THEN
        RAISE EXCEPTION 'armed provider mutation cannot be re-queued';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fidy_resolve_wompi_billing_user_by_transaction(transaction_id text)
    RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
    SET search_path = pg_catalog, pg_temp AS $$
      SELECT user_id FROM public.billing_attempt_transactions
      WHERE wompi_transaction_id = transaction_id
    $$;

    CREATE OR REPLACE FUNCTION fidy_billing_reconciliation_escalations() RETURNS TABLE (
      "awaitingReferenceCount" int,
      "awaitingReferenceMaxAgeSeconds" int,
      "providerStalledCount" int,
      "providerStalledMaxAgeSeconds" int,
      "manualReconciliationCount" int,
      "manualReconciliationMaxAgeSeconds" int
    )
    LANGUAGE sql SECURITY DEFINER STABLE
    SET search_path = pg_catalog, pg_temp AS $$
      SELECT
        count(*) FILTER (WHERE attempt.awaiting_reference_since IS NOT NULL)::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - attempt.awaiting_reference_since)))
          FILTER (WHERE attempt.awaiting_reference_since IS NOT NULL), 0)::int,
        count(*) FILTER (
          WHERE attempt.manual_reconciliation_since IS NULL
            AND attempt.armed_at <= now() - interval '24 hours'
            AND EXISTS (
              SELECT 1 FROM public.billing_attempt_transactions AS transaction
              WHERE transaction.billing_attempt_id = attempt.id
            )
        )::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - attempt.armed_at))) FILTER (
          WHERE attempt.manual_reconciliation_since IS NULL
            AND attempt.armed_at <= now() - interval '24 hours'
            AND EXISTS (
              SELECT 1 FROM public.billing_attempt_transactions AS transaction
              WHERE transaction.billing_attempt_id = attempt.id
            )
        ), 0)::int,
        count(*) FILTER (WHERE attempt.manual_reconciliation_since IS NOT NULL)::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - attempt.manual_reconciliation_since)))
          FILTER (WHERE attempt.manual_reconciliation_since IS NOT NULL), 0)::int
      FROM public.billing_attempts AS attempt
      WHERE attempt.status = 'pending'
    $$;

    ALTER TABLE billing_attempts DROP COLUMN wompi_transaction_id;

    ALTER FUNCTION fidy_resolve_wompi_billing_user(text) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_resolve_wompi_billing_user_by_transaction(text) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_billing_reconciliation_escalations() OWNER TO fidy_gateway;
    GRANT SELECT ON billing_attempts, billing_attempt_transactions TO fidy_gateway;

    GRANT SELECT, INSERT ON billing_attempt_transactions TO fidy_runtime;
    GRANT UPDATE (status, finalized_at, last_observed_at)
      ON billing_attempt_transactions TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
