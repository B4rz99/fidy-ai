import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations } from "~/shell/database/internal/migrations/registry";
import { assertRuntimeAuthority } from "~/shell/database/internal/runtime-authority";
import { MigrationSqlClient } from "./operations";

const runtimeDatabaseUrl = Config.redacted("DATABASE_URL").pipe(
  Config.mapOrFail((redacted) =>
    Schema.decodeEffect(Schema.URLFromString)(Redacted.value(redacted)).pipe(
      Effect.map((url) => {
        url.searchParams.append("options", "-c search_path=fidy_durable,public");
        return Redacted.make(url.href);
      }),
      Effect.mapError(
        () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({ message: "DATABASE_URL must be a valid URL" })
          )
      )
    )
  )
);

/**
 * Runtime Postgres pool. DATABASE_URL must authenticate as fidy_runtime; its dedicated first
 * search-path schema permits Effect's native stores to migrate without authority over public.
 */
export const PgLive = PgClient.layerConfig({ url: runtimeDatabaseUrl });

const PgMigrationLive = PgClient.layerConfig({
  url: Config.redacted("MIGRATION_DATABASE_URL"),
});

/** Runtime-authority startup gate, provided before any application process can query Postgres. */
export const RuntimeAuthorityLive = Layer.effectDiscard(assertRuntimeAuthority);

/** Runs the sole globally ordered migration registry through the separately privileged connection. */
export const MigratorLive = PgMigrator.layer({
  loader: PgMigrator.fromRecord(migrations),
}).pipe(Layer.provide(PgMigrationLive));

/** Privileged local/setup pool; production application assembly never receives it. */
export const MigrationPgLive = PgMigrationLive;

/** Builds the privileged SQL capability without replacing the runtime SqlClient in context. */
export const MigrationSqlClientLive = Layer.effect(MigrationSqlClient, SqlClient.SqlClient).pipe(
  Layer.provide(PgMigrationLive)
);
