import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";

/** Resets statement ingestion and its Transaction outcomes between integration tests. */
export const truncateStatementIngestion = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM statement_backfill_entitlements`;
  yield* sql`DELETE FROM needs_review_items`;
  yield* sql`TRUNCATE source_attestations, transactions`;
  yield* sql`DELETE FROM statement_format_profiles`;
  yield* sql`DELETE FROM statement_submissions`;
});
