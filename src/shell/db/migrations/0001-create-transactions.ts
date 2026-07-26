import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const createTransactions = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`
      CREATE TABLE transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        amount integer NOT NULL CHECK (amount > 0),
        currency text NOT NULL,
        merchant text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('inflow', 'outflow')),
        occurred_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `
).pipe(Effect.asVoid);
