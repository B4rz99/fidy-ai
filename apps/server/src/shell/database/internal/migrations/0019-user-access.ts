import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Access belongs to the stable User: the paid tier can change, while the
// one-time TrialPeriod remains an exact immutable interval.
export const userAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE users
      ADD COLUMN paid_tier text,
      ADD COLUMN trial_started_at timestamptz,
      ADD COLUMN trial_ends_at timestamptz
  `;

  yield* sql`
    UPDATE users
    SET paid_tier = 'free',
        trial_started_at = created_at,
        trial_ends_at = created_at + INTERVAL '168 hours'
  `;

  yield* sql`
    ALTER TABLE users
      ALTER COLUMN paid_tier SET NOT NULL,
      ALTER COLUMN trial_started_at SET NOT NULL,
      ALTER COLUMN trial_ends_at SET NOT NULL,
      ADD CONSTRAINT users_paid_tier_check CHECK (paid_tier IN ('free', 'pro')),
      ADD CONSTRAINT users_trial_period_check CHECK (
        trial_ends_at = trial_started_at + INTERVAL '168 hours'
      )
  `;
}).pipe(Effect.asVoid);
