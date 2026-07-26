import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config } from "effect";
import { migrations } from "~/shell/db/migrations/registry";

/** Postgres client — DATABASE_URL is required; boot fails loudly without it. */
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});

/** Runs pending migrations at boot. */
export const MigratorLive = PgMigrator.layer({
  loader: PgMigrator.fromRecord(migrations),
});
