import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Records confirmed RecurringSeries, keyed so one Counterparty's Currencies never merge. */
export const recurringSeries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE recurring_series (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterparty text NOT NULL CHECK (length(btrim(counterparty)) BETWEEN 1 AND 120),
      direction text NOT NULL CHECK (direction IN ('inflow', 'outflow')),
      cadence text NOT NULL CHECK (cadence IN (
        'weekly',
        'fortnightly',
        'monthly',
        'quarterly',
        'yearly'
      )),
      typical_amount numeric NOT NULL CHECK (typical_amount > 0),
      typical_currency text NOT NULL,
      -- Only the floor is enforced here: distinctness needs a subquery, which a CHECK
      -- constraint may not contain, so RecurringSeries owns that invariant at decode.
      occurrences uuid[] NOT NULL CHECK (cardinality(occurrences) >= 3),
      first_occurred_at timestamptz NOT NULL,
      last_occurred_at timestamptz NOT NULL CHECK (last_occurred_at >= first_occurred_at),
      suppression_reason text CHECK (suppression_reason IN ('backfill', 'cold-start')),
      detected_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, counterparty, direction, typical_currency)
    )
  `;
  yield* sql`
    CREATE INDEX recurring_series_user_currency_counterparty_idx
      ON recurring_series (user_id, typical_currency, counterparty, direction, id)
  `;

  yield* sql`
    ALTER TABLE recurring_series ENABLE ROW LEVEL SECURITY;
    ALTER TABLE recurring_series FORCE ROW LEVEL SECURITY;
    CREATE POLICY recurring_series_by_user ON recurring_series
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;

  yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_series TO fidy_runtime`;
}).pipe(Effect.asVoid);
