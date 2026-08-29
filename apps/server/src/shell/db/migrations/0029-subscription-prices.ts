import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Publishes the three immutable Colombia Subscription offers without granting runtime writes. */
export const subscriptionPrices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE prices (
      id uuid PRIMARY KEY,
      amount numeric NOT NULL CHECK (amount > 0),
      currency text NOT NULL CHECK (currency = 'COP'),
      billing_period text NOT NULL CHECK (billing_period IN ('weekly', 'monthly', 'yearly')),
      service_market text NOT NULL CHECK (service_market = 'CO'),
      tax_treatment text NOT NULL CHECK (tax_treatment = 'not-taxable'),
      automatic_renewal boolean NOT NULL CHECK (automatic_renewal),
      renewal_reminder text NOT NULL CHECK (renewal_reminder = 'none'),
      cancellation text NOT NULL CHECK (cancellation = 'future-renewals-only'),
      paid_access_ends text NOT NULL CHECK (paid_access_ends = 'paid-period-end'),
      payment_methods text[] NOT NULL CHECK (
        payment_methods = ARRAY['card', 'nequi', 'daviplata']::text[]
      )
    )
  `;

  yield* sql`
    INSERT INTO prices (
      id, amount, currency, billing_period, service_market, tax_treatment, automatic_renewal,
      renewal_reminder, cancellation, paid_access_ends, payment_methods
    ) VALUES
      (
        '22700000-0000-4000-8000-000000000001', 9900, 'COP', 'weekly', 'CO',
        'not-taxable', true, 'none', 'future-renewals-only', 'paid-period-end',
        ARRAY['card', 'nequi', 'daviplata']::text[]
      ),
      (
        '22700000-0000-4000-8000-000000000002', 28900, 'COP', 'monthly', 'CO',
        'not-taxable', true, 'none', 'future-renewals-only', 'paid-period-end',
        ARRAY['card', 'nequi', 'daviplata']::text[]
      ),
      (
        '22700000-0000-4000-8000-000000000003', 289900, 'COP', 'yearly', 'CO',
        'not-taxable', true, 'none', 'future-renewals-only', 'paid-period-end',
        ARRAY['card', 'nequi', 'daviplata']::text[]
      )
  `;

  yield* sql`
    CREATE TABLE published_prices (
      offer_order smallint PRIMARY KEY CHECK (offer_order BETWEEN 1 AND 3),
      price_id uuid NOT NULL UNIQUE REFERENCES prices(id)
    )
  `;

  yield* sql`
    INSERT INTO published_prices (offer_order, price_id) VALUES
      (1, '22700000-0000-4000-8000-000000000001'),
      (2, '22700000-0000-4000-8000-000000000002'),
      (3, '22700000-0000-4000-8000-000000000003')
  `;

  yield* sql`GRANT SELECT ON prices, published_prices TO fidy_runtime`;
}).pipe(Effect.asVoid);
