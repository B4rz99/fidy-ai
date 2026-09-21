import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations } from "~/shell/database/internal/migrations/registry";
import { pgTypeRegistry } from "~/shell/database/internal/pg-type-registry";
import { assertRuntimeAuthority } from "~/shell/database/internal/runtime-authority";
import { MigrationSqlClient } from "./operations";

const runtimeDatabaseUrl = Config.Redacted("DATABASE_URL").pipe(
  Config.mapEffect((redacted) =>
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
 * The session time zone is pinned to UTC: the driver binds a JavaScript `Date` as `timestamptz`,
 * and PostgreSQL converts it against the session zone when the target column is `timestamp`, so
 * the zone is what keeps a UTC instant's wall-clock fields intact on both column kinds.
 */
export const PgLive = PgClient.layerConfig({
  url: runtimeDatabaseUrl,
  // `layerConfig` recursively unwraps plain values, so the registry crossing it must be a Config
  // to keep its identity: the driver resolves codecs through a WeakMap keyed by the registry.
  types: Config.succeed(pgTypeRegistry),
  startupParameters: Config.succeed({ TimeZone: "UTC" }),
});

const PgMigrationLive = PgClient.layerConfig({
  url: Config.Redacted("MIGRATION_DATABASE_URL"),
  types: Config.succeed(pgTypeRegistry),
  startupParameters: Config.succeed({ TimeZone: "UTC" }),
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
