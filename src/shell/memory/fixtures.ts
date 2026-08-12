import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";

/** Clears current Memories through migration authority for isolated real-Postgres tests. */
export const truncateMemories = Effect.flatMap(
  MigrationSqlClient,
  (sql) => sql`TRUNCATE memories`
).pipe(Effect.orDie);
