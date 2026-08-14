import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";

/** Resets append-only AuditLogEntry state between API-seam tests. */
export const truncateAuditLogEntries = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE audit_log_entries`;
});
