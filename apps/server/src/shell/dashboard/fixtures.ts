import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/testing/database-harness";

/** Deletes every persisted dashboard so an API-seam attempt starts from first use. */
export const truncateDashboards = Effect.flatMap(
  MigrationSqlClient,
  (sql) => sql`TRUNCATE TABLE dashboards`
).pipe(Effect.asVoid, Effect.orDie);
