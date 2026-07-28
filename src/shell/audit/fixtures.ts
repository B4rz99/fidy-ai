import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Resets append-only AuditLogEntry state between API-seam tests. */
export const truncateAuditLogEntries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE audit_log_entries`;
});
