import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { migrations } from "~/shell/db/migrations/registry";
import { userTableNames } from "./user-tables";

/** Runtime Postgres pool. DATABASE_URL must authenticate as the restricted fidy_runtime role. */
export const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});

const PgMigrationLive = PgClient.layerConfig({
  url: Config.redacted("MIGRATION_DATABASE_URL"),
});

const RuntimeAuthority = Schema.Struct({
  roleName: Schema.String,
  sessionRoleName: Schema.String,
  isSuperuser: Schema.Boolean,
  bypassesRls: Schema.Boolean,
  ownsUserTables: Schema.Boolean,
  hasPrivilegedMembership: Schema.Boolean,
});

/**
 * Fails startup unless the runtime connection has exactly the deliberately
 * granted role and none of PostgreSQL's RLS-bypass authorities. This check runs
 * after migrations, before HTTP or background work starts.
 */
export const assertRuntimeAuthority = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  SqlSchema.findOne({
    Request: Schema.Void,
    Result: RuntimeAuthority,
    execute: () => sql`
      SELECT current_user AS "roleName", session_user AS "sessionRoleName",
        role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY(${userTableNames})
            AND relation.relowner = role.oid
        ) AS "ownsUserTables",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles AS granted_role
          WHERE granted_role.oid <> role.oid
            AND pg_catalog.pg_has_role(role.oid, granted_role.oid, 'MEMBER')
            AND (
              granted_role.rolsuper
              OR granted_role.rolbypassrls
              OR EXISTS (
                SELECT 1
                FROM pg_catalog.pg_class AS owned_relation
                INNER JOIN pg_catalog.pg_namespace AS owned_namespace
                  ON owned_namespace.oid = owned_relation.relnamespace
                WHERE owned_namespace.nspname = 'public'
                  AND owned_relation.relname = ANY(${userTableNames})
                  AND owned_relation.relowner = granted_role.oid
              )
            )
        ) AS "hasPrivilegedMembership"
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user
    `,
  })(undefined)
).pipe(
  Effect.flatMap((authority) =>
    authority.roleName === "fidy_runtime" &&
    authority.sessionRoleName === "fidy_runtime" &&
    !authority.isSuperuser &&
    !authority.bypassesRls &&
    !authority.ownsUserTables &&
    !authority.hasPrivilegedMembership
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
  "fidy-ai/shell/db/client/MigrationSqlClient"
) {}

/** Builds the isolated setup client without replacing the runtime SqlClient in context. */
export const MigrationSqlClientLive = Layer.effect(MigrationSqlClient, SqlClient.SqlClient).pipe(
  Layer.provide(PgMigrationLive)
);
