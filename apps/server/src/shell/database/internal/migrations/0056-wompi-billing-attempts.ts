import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds durable Wompi collection attempts, immutable snapshots, periods, and provider observations. */
export const wompiBillingAttempts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE subscriptions ADD COLUMN id uuid DEFAULT gen_random_uuid() NOT NULL;
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_id_unique UNIQUE (id);
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_id_user_unique UNIQUE (id, user_id);
    ALTER TABLE card_enrollments ADD CONSTRAINT card_enrollments_id_user_unique UNIQUE (id, user_id);
    ALTER TABLE card_payment_sources ADD CONSTRAINT card_payment_sources_id_user_unique UNIQUE (id, user_id);

    CREATE TABLE billing_attempts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id uuid NOT NULL,
      payment_request_id uuid NOT NULL,
      card_enrollment_id uuid NOT NULL,
      payment_source_id uuid NOT NULL,
      price_id uuid NOT NULL REFERENCES prices(id),
      amount numeric NOT NULL CHECK (amount > 0),
      currency text NOT NULL,
      billing_period text NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
      service_market text NOT NULL CHECK (service_market = 'CO'),
      tax_treatment text NOT NULL CHECK (tax_treatment = 'not-taxable'),
      time_zone text NOT NULL,
      wompi_environment text NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
      wompi_transaction_reference text NOT NULL UNIQUE,
      wompi_transaction_id text UNIQUE,
      status text NOT NULL CHECK (status IN ('pending', 'failed', 'succeeded')),
      charge_state text NOT NULL CHECK (charge_state IN ('queued', 'armed')),
      created_at timestamptz NOT NULL,
      armed_at timestamptz,
      failed_at timestamptz,
      finalized_at timestamptz,
      CHECK ((charge_state = 'armed') = (armed_at IS NOT NULL)),
      CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
      CHECK ((status = 'succeeded') = (finalized_at IS NOT NULL)),
      UNIQUE (user_id, payment_request_id),
      UNIQUE (id, user_id),
      FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions(id, user_id),
      FOREIGN KEY (card_enrollment_id, user_id) REFERENCES card_enrollments(id, user_id),
      FOREIGN KEY (payment_source_id, user_id) REFERENCES card_payment_sources(id, user_id)
    );

    CREATE UNIQUE INDEX billing_attempts_one_pending_price
      ON billing_attempts(user_id, subscription_id, price_id) WHERE status = 'pending';

    CREATE TABLE paid_subscription_periods (
      billing_attempt_id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id uuid NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
      renewal_anchor timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      FOREIGN KEY (billing_attempt_id, user_id) REFERENCES billing_attempts(id, user_id),
      FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions(id, user_id)
    );

    CREATE TABLE wompi_billing_observations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      billing_attempt_id uuid NOT NULL,
      event_checksum text NOT NULL,
      wompi_transaction_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')),
      amount_in_cents bigint NOT NULL CHECK (amount_in_cents > 0),
      currency text NOT NULL,
      wompi_source_id bigint NOT NULL CHECK (wompi_source_id > 0),
      wompi_environment text NOT NULL CHECK (wompi_environment IN ('sandbox', 'production')),
      finalized_at timestamptz,
      observed_at timestamptz NOT NULL,
      UNIQUE (billing_attempt_id, event_checksum),
      FOREIGN KEY (billing_attempt_id, user_id) REFERENCES billing_attempts(id, user_id)
    );

    CREATE FUNCTION fidy_preserve_billing_snapshot() RETURNS trigger
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
      IF OLD.wompi_transaction_id IS NOT NULL AND
         NEW.wompi_transaction_id IS DISTINCT FROM OLD.wompi_transaction_id THEN
        RAISE EXCEPTION 'Wompi transaction identity is immutable once known';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER billing_attempt_snapshot_immutable
      BEFORE UPDATE OR DELETE ON billing_attempts
      FOR EACH ROW EXECUTE FUNCTION fidy_preserve_billing_snapshot();

    CREATE FUNCTION fidy_preserve_paid_period() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'paid Subscription period is immutable'; END; $$;
    CREATE TRIGGER paid_period_immutable BEFORE UPDATE OR DELETE ON paid_subscription_periods
      FOR EACH ROW EXECUTE FUNCTION fidy_preserve_paid_period();
    CREATE TRIGGER wompi_billing_observation_append_only
      BEFORE UPDATE OR DELETE ON wompi_billing_observations
      FOR EACH ROW EXECUTE FUNCTION fidy_preserve_paid_period();

    ALTER TABLE billing_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE billing_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY billing_attempts_by_user ON billing_attempts
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE paid_subscription_periods ENABLE ROW LEVEL SECURITY;
    ALTER TABLE paid_subscription_periods FORCE ROW LEVEL SECURITY;
    CREATE POLICY paid_subscription_periods_by_user ON paid_subscription_periods
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE wompi_billing_observations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wompi_billing_observations FORCE ROW LEVEL SECURITY;
    CREATE POLICY wompi_billing_observations_by_user ON wompi_billing_observations
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    CREATE FUNCTION fidy_resolve_wompi_billing_user(reference_text text) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    SET search_path = pg_catalog, pg_temp AS $$
      SELECT user_id FROM public.billing_attempts
      WHERE wompi_transaction_reference = reference_text
    $$;
    REVOKE ALL ON FUNCTION fidy_resolve_wompi_billing_user(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_resolve_wompi_billing_user(text) TO fidy_runtime;

    CREATE FUNCTION fidy_resolve_wompi_billing_user_by_transaction(transaction_id text)
    RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE
    SET search_path = pg_catalog, pg_temp AS $$
      SELECT user_id FROM public.billing_attempts
      WHERE wompi_transaction_id = transaction_id
    $$;
    REVOKE ALL ON FUNCTION fidy_resolve_wompi_billing_user_by_transaction(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_resolve_wompi_billing_user_by_transaction(text) TO fidy_runtime;

    GRANT SELECT, INSERT ON billing_attempts, paid_subscription_periods,
      wompi_billing_observations TO fidy_runtime;
    GRANT UPDATE (wompi_transaction_id, status, charge_state, armed_at, failed_at, finalized_at)
      ON billing_attempts TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
