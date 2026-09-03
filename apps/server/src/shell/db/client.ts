import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations } from "~/shell/db/migrations/registry";
import { hasUnsafeAuthority, readRuntimeAuthority } from "./runtime-authority";

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

/**
 * Fails startup unless the runtime connection has exactly the deliberately
 * granted role and no authority to bypass isolation or alter application schema.
 */
export const assertRuntimeAuthority = Effect.flatMap(
  SqlClient.SqlClient,
  readRuntimeAuthority
).pipe(
  Effect.flatMap((authority) =>
    authority.connectionRole === "fidy_runtime" &&
    authority.sessionRole === "fidy_runtime" &&
    authority.canLogin &&
    !hasUnsafeAuthority(authority)
      ? Effect.void
      : Effect.die(new Error("DATABASE_URL must use the restricted fidy_runtime role."))
  ),
  Effect.catchTag("SqlError", (error) => Effect.die(error))
);

/** Runtime-authority startup gate, provided before any application process can query Postgres. */
export const RuntimeAuthorityLive = Layer.effectDiscard(assertRuntimeAuthority);

/** Runs the globally ordered migrations through the separately privileged connection. */
export const MigratorLive = PgMigrator.layer({
  loader: PgMigrator.fromRecord(migrations),
}).pipe(Layer.provide(PgMigrationLive));

/** Privileged local/setup pool; production application assembly never receives it. */
export const MigrationPgLive = PgMigrationLive;

/** Privileged SQL client exposed only to test cleanup and migration-aware setup helpers. */
export class MigrationSqlClient extends Context.Service<MigrationSqlClient, SqlClient.SqlClient>()(
  "@fidy/server/shell/db/client/MigrationSqlClient"
) {
  /** Builds the isolated setup client without replacing the runtime SqlClient in context. */
  static readonly layer = Layer.effect(this, SqlClient.SqlClient).pipe(
    Layer.provide(PgMigrationLive)
  );
}
