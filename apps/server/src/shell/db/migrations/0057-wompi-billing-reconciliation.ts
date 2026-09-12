import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Adds the two explicit operational reconciliation markers a durable BillingAttempt workflow can
 * set, and a bounded aggregate probe operators read. Both markers are additive: the existing
 * charge-state CHECK and immutability trigger only change what may happen to `charge_state`, which
 * this migration leaves alone.
 */
export const wompiBillingReconciliation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE billing_attempts ADD COLUMN awaiting_reference_since timestamptz;
    ALTER TABLE billing_attempts ADD COLUMN manual_reconciliation_since timestamptz;

    GRANT UPDATE (awaiting_reference_since, manual_reconciliation_since)
      ON billing_attempts TO fidy_runtime;

    CREATE FUNCTION fidy_billing_reconciliation_escalations() RETURNS TABLE (
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
        count(*) FILTER (WHERE awaiting_reference_since IS NOT NULL)::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - awaiting_reference_since)))
          FILTER (WHERE awaiting_reference_since IS NOT NULL), 0)::int,
        count(*) FILTER (
          WHERE wompi_transaction_id IS NOT NULL AND manual_reconciliation_since IS NULL
            AND armed_at <= now() - interval '24 hours'
        )::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - armed_at))) FILTER (
          WHERE wompi_transaction_id IS NOT NULL AND manual_reconciliation_since IS NULL
            AND armed_at <= now() - interval '24 hours'
        ), 0)::int,
        count(*) FILTER (WHERE manual_reconciliation_since IS NOT NULL)::int,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - manual_reconciliation_since)))
          FILTER (WHERE manual_reconciliation_since IS NOT NULL), 0)::int
      FROM public.billing_attempts
      WHERE status = 'pending'
    $$;
    ALTER FUNCTION fidy_billing_reconciliation_escalations() OWNER TO fidy_gateway;
    GRANT SELECT ON billing_attempts TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_billing_reconciliation_escalations() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_billing_reconciliation_escalations() TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
