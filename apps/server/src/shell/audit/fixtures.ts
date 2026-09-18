import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/testing/database-harness";

/** Resets append-only AuditLogEntry state between API-seam tests. */
export const truncateAuditLogEntries = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE audit_log_entries`;
});
