import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds private facts recording which current Transaction fields the User explicitly decided. */
export const transactionUserDecisions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE transactions
      ADD COLUMN category_user_decided boolean NOT NULL DEFAULT false,
      ADD COLUMN counterparty_user_decided boolean NOT NULL DEFAULT false,
      ADD COLUMN notes_user_decided boolean NOT NULL DEFAULT false
  `;
}).pipe(Effect.asVoid);
