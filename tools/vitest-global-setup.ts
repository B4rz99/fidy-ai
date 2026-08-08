import { Effect } from "effect";
import { MigrationSqlClient } from "../src/shell/db/client";

const resetPersistentDatabase = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;

  // Recreate the test schema so the suite's instrumented Migrator runs every time. Besides
  // clearing rows, CASCADE removes any trigger or function left behind by an interrupted test.
  yield* sql`DROP SCHEMA public CASCADE`;
  yield* sql`CREATE SCHEMA public AUTHORIZATION CURRENT_USER`;
  yield* sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
}).pipe(Effect.provide(MigrationSqlClient.layer));

/** Resets the configured test database before Vitest loads any test files. */
export const setup = async (): Promise<void> => {
  await Effect.runPromise(resetPersistentDatabase);
};
