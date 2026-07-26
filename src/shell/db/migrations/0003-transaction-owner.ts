import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Ownership lives in storage, never on the wire (ARCHITECTURE.md §5): the
// column is here, the projection the repo selects still returns only the
// canonical Transaction fields.
//
// NOT NULL with no default and no backfill: a row written before this migration
// was learned from nobody, and inventing an owner for it would hand one user's
// money to another. On a database holding such rows the ALTER fails loudly and
// a person decides — which is the point.
//
// No foreign key yet: the users table is the identity slice's to create, and a
// reference to a table that does not exist is not a constraint.
export const transactionOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE transactions ADD COLUMN user_id uuid NOT NULL`;

  // Matches the only read the slice performs: one owner's history, newest
  // first.
  yield* sql`
    CREATE INDEX transactions_user_id_occurred_at_idx
      ON transactions (user_id, occurred_at DESC, created_at DESC)
  `;
}).pipe(Effect.asVoid);
