import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// This is the disposable walking-skeleton migration's final shape. Money stays
// nested in the domain and contract but occupies adjacent exact numeric and
// Currency columns here; ownership exists only at this relational seam.
export const createTransactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      amount numeric NOT NULL CHECK (amount > 0),
      currency text NOT NULL,
      merchant text NOT NULL,
      direction text NOT NULL CHECK (direction IN ('inflow', 'outflow')),
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE INDEX transactions_user_id_occurred_at_idx
      ON transactions (user_id, occurred_at DESC, created_at DESC)
  `;
}).pipe(Effect.asVoid);
