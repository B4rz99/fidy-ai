import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// bigint headroom for large COP amounts; capped at 2^53 - 1 so every stored
// value survives the JSON-number decode on read.
export const amountBigint = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`
      ALTER TABLE transactions
        ALTER COLUMN amount TYPE bigint,
        ADD CONSTRAINT amount_within_json_safe_range CHECK (amount <= 9007199254740991)
    `
).pipe(Effect.asVoid);
