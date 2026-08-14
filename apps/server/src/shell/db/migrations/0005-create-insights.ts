import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** InsightEvents retain generation facts; send evidence appends beside them. */
export const createInsights = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE insight_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      kind text NOT NULL CHECK (kind IN (
        'budget-threshold',
        'new-recurring-series',
        'weekly-summary',
        'manual-entry-reminder'
      )),
      schedule_id uuid NOT NULL,
      schedule_version integer NOT NULL CHECK (schedule_version > 0),
      service_market text NOT NULL CHECK (service_market = 'CO'),
      locale text NOT NULL CHECK (locale = 'es-CO'),
      time_zone text NOT NULL,
      scheduled_at timestamptz NOT NULL,
      lifecycle_state text NOT NULL DEFAULT 'pending' CHECK (
        lifecycle_state IN ('pending', 'delivered', 'read', 'dismissed')
      )
    )
  `;

  yield* sql`
    CREATE INDEX insight_events_user_pending_scheduled_idx
      ON insight_events (user_id, scheduled_at, id)
      WHERE lifecycle_state = 'pending'
  `;

  yield* sql`
    CREATE TABLE insight_money_groups (
      insight_event_id uuid NOT NULL REFERENCES insight_events(id),
      currency text NOT NULL,
      inflow_amount numeric NOT NULL CHECK (inflow_amount >= 0),
      outflow_amount numeric NOT NULL CHECK (outflow_amount >= 0),
      PRIMARY KEY (insight_event_id, currency),
      CHECK (inflow_amount <> 0 OR outflow_amount <> 0)
    )
  `;

  yield* sql`
    CREATE TABLE insight_delivery_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      insight_event_id uuid NOT NULL UNIQUE REFERENCES insight_events(id),
      sent_at timestamptz NOT NULL,
      channel text NOT NULL CHECK (length(btrim(channel)) BETWEEN 1 AND 32),
      provider text NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 64),
      provider_message_id text NOT NULL CHECK (
        length(btrim(provider_message_id)) BETWEEN 1 AND 256
      )
    )
  `;
}).pipe(Effect.asVoid);
