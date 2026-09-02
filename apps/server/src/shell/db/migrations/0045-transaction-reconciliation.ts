import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds reversible pair decisions and private correction timing for effective Transaction facts. */
export const transactionReconciliation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE transactions
      ADD COLUMN facts_corrected_at timestamptz,
      ADD CONSTRAINT transactions_user_id_id_key UNIQUE (user_id, id)
  `;

  yield* sql`
    CREATE TABLE transaction_reconciliation_decisions (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      first_transaction_id uuid NOT NULL,
      second_transaction_id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('linked', 'keep-separate')),
      visible_transaction_id uuid,
      statement_transaction_id uuid,
      movement_transaction_id uuid,
      category_transaction_id uuid,
      counterparty_transaction_id uuid,
      notes_transaction_id uuid,
      decided_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, first_transaction_id, second_transaction_id),
      FOREIGN KEY (user_id, first_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, second_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, visible_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, statement_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, movement_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, category_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, counterparty_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, notes_transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      CHECK (first_transaction_id::text < second_transaction_id::text),
      CHECK (
        (state = 'linked' AND visible_transaction_id IS NOT NULL
          AND movement_transaction_id IS NOT NULL
          AND category_transaction_id IS NOT NULL
          AND counterparty_transaction_id IS NOT NULL
          AND notes_transaction_id IS NOT NULL)
        OR (state = 'keep-separate' AND visible_transaction_id IS NULL
          AND statement_transaction_id IS NULL AND movement_transaction_id IS NULL
          AND category_transaction_id IS NULL AND counterparty_transaction_id IS NULL
          AND notes_transaction_id IS NULL)
      ),
      CHECK (
        visible_transaction_id IS NULL
        OR visible_transaction_id IN (first_transaction_id, second_transaction_id)
      ),
      CHECK (
        statement_transaction_id IS NULL
        OR statement_transaction_id IN (first_transaction_id, second_transaction_id)
      ),
      CHECK (movement_transaction_id IS NULL
        OR movement_transaction_id IN (first_transaction_id, second_transaction_id)),
      CHECK (category_transaction_id IS NULL
        OR category_transaction_id IN (first_transaction_id, second_transaction_id)),
      CHECK (counterparty_transaction_id IS NULL
        OR counterparty_transaction_id IN (first_transaction_id, second_transaction_id)),
      CHECK (notes_transaction_id IS NULL
        OR notes_transaction_id IN (first_transaction_id, second_transaction_id))
    )
  `;

  yield* sql`
    CREATE TABLE transaction_reconciliation_members (
      user_id uuid NOT NULL,
      transaction_id uuid NOT NULL,
      first_transaction_id uuid NOT NULL,
      second_transaction_id uuid NOT NULL,
      PRIMARY KEY (user_id, transaction_id),
      FOREIGN KEY (user_id, transaction_id)
        REFERENCES transactions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, first_transaction_id, second_transaction_id)
        REFERENCES transaction_reconciliation_decisions(
          user_id, first_transaction_id, second_transaction_id
        ) ON DELETE CASCADE,
      CHECK (transaction_id IN (first_transaction_id, second_transaction_id))
    )
  `;

  for (const table of [
    "transaction_reconciliation_decisions",
    "transaction_reconciliation_members",
  ]) {
    yield* sql.unsafe(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${table}_by_user ON ${table}
        USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
        WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO fidy_runtime
    `);
  }
}).pipe(Effect.asVoid);
