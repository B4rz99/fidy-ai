import { Effect, Layer } from "effect";
import { MigrationSqlClient, MigrationSqlClientLive, MigratorLive } from "../src/shell/db/client";

const resetPersistentDatabase = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;

  // A killed consent-gate test can leave these behind and poison later runs.
  yield* sql`DROP TRIGGER IF EXISTS reject_gate_test_consent ON consent_records`;
  yield* sql`DROP FUNCTION IF EXISTS reject_gate_test_consent()`;

  // Keep migration metadata and the migration-seeded category reference data.
  yield* sql`
    DO $$
    DECLARE
      application_tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
      INTO application_tables
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('categories', 'effect_sql_migrations');

      IF application_tables IS NOT NULL THEN
        EXECUTE 'TRUNCATE TABLE ' || application_tables || ' RESTART IDENTITY CASCADE';
      END IF;
    END
    $$
  `;
}).pipe(Effect.provide(MigrationSqlClientLive));

/** Migrates, then resets the configured test database before Vitest loads any test files. */
export const setup = async (): Promise<void> => {
  await Effect.runPromise(Effect.scoped(Layer.build(MigratorLive)));
  await Effect.runPromise(resetPersistentDatabase);
};
