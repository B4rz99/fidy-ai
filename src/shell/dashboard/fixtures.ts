import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Deletes every persisted dashboard so an API-seam attempt starts from first use. */
export const truncateDashboards = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`TRUNCATE TABLE dashboards`
).pipe(Effect.asVoid, Effect.orDie);
