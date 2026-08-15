import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Renames the Transaction party and permits captures that identify no Counterparty. */
export const optionalTransactionCounterparty = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE transactions RENAME COLUMN merchant TO counterparty;
    ALTER TABLE transactions ALTER COLUMN counterparty DROP NOT NULL
  `;
});
