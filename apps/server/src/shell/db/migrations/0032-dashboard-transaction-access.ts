import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { normalizedTransactionSearchSql } from "~/shell/transactions/search-sql";

/** Adds partial access paths for bounded Dashboard lists, period aggregates, and private search. */
export const dashboardTransactionAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX transactions_dashboard_recent_idx
      ON transactions (user_id, occurred_at DESC, created_at DESC, id DESC)
      INCLUDE (amount, currency, counterparty, direction, category_id)
      WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX transactions_dashboard_period_idx
      ON transactions (user_id, occurred_at, category_id, currency, direction)
      INCLUDE (amount)
      WHERE deleted_at IS NULL
  `;
  yield* sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  yield* sql`
    CREATE INDEX transactions_dashboard_search_idx
      ON transactions USING gin (
        (${sql.literal(normalizedTransactionSearchSql)}) gin_trgm_ops
      )
      WHERE deleted_at IS NULL
  `;
}).pipe(Effect.asVoid);
