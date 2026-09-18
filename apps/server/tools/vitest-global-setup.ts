import { Effect } from "effect";
import { MigrationSqlClient } from "../src/shell/db/client";

const resetPersistentDatabase = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;

  // Recreate both namespaces so the suite's instrumented Migrator and Effect's native stores
  // start from a clean database. The durable namespace is intentionally outside the application
  // migrator's public schema, so resetting only `public` leaves stale queues, messages, runners,
  // and topology identities behind after interrupted or previous test runs.
  yield* sql`DROP SCHEMA public CASCADE`;
  yield* sql`DROP SCHEMA IF EXISTS fidy_durable CASCADE`;
  yield* sql`CREATE SCHEMA public AUTHORIZATION CURRENT_USER`;
  yield* sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
}).pipe(Effect.provide(MigrationSqlClient.layer));

/** Resets the configured test database before Vitest loads any test files. */
export const setup = async (): Promise<void> => {
  await Effect.runPromise(resetPersistentDatabase);
};
