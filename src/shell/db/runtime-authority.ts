import { Schema } from "effect";
import { SqlSchema, type SqlClient } from "effect/unstable/sql";

const RuntimeAuthority = Schema.Struct({
  connectionRole: Schema.String,
  sessionRole: Schema.String,
  canLogin: Schema.Boolean,
  isSuperuser: Schema.Boolean,
  isRoleCreator: Schema.Boolean,
  isDatabaseCreator: Schema.Boolean,
  canReplicate: Schema.Boolean,
  bypassesRls: Schema.Boolean,
  ownsDatabase: Schema.Boolean,
  ownsPublicSchema: Schema.Boolean,
  ownsPublicRelations: Schema.Boolean,
  canCreateDatabase: Schema.Boolean,
  canCreateSchema: Schema.Boolean,
  hasRoleMembership: Schema.Boolean,
});

export type RuntimeAuthority = typeof RuntimeAuthority.Type;

/** Reads every database authority forbidden to the fixed fidy_runtime role. */
export const readRuntimeAuthority = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOne({
    Request: Schema.Void,
    Result: RuntimeAuthority,
    execute: () => sql`
      SELECT current_user AS "connectionRole", session_user AS "sessionRole",
        runtime.rolcanlogin AS "canLogin", runtime.rolsuper AS "isSuperuser",
        runtime.rolcreaterole AS "isRoleCreator", runtime.rolcreatedb AS "isDatabaseCreator",
        runtime.rolreplication AS "canReplicate", runtime.rolbypassrls AS "bypassesRls",
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_database AS database
          WHERE database.datname = current_database() AND database.datdba = runtime.oid
        ) AS "ownsDatabase",
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspname = 'public' AND namespace.nspowner = runtime.oid
        ) AS "ownsPublicSchema",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND relation.relowner = runtime.oid
        ) AS "ownsPublicRelations",
        pg_catalog.has_database_privilege(runtime.oid, current_database(), 'CREATE')
          AS "canCreateDatabase",
        pg_catalog.has_schema_privilege(runtime.oid, 'public', 'CREATE')
          AS "canCreateSchema",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles AS granted
          WHERE granted.oid <> runtime.oid
            AND pg_catalog.pg_has_role(runtime.oid, granted.oid, 'MEMBER')
        ) AS "hasRoleMembership"
      FROM pg_catalog.pg_roles AS runtime
      WHERE runtime.rolname = 'fidy_runtime'
    `,
  })(undefined);

const unsafeAuthorityFields = [
  "isSuperuser",
  "isRoleCreator",
  "isDatabaseCreator",
  "canReplicate",
  "bypassesRls",
  "ownsDatabase",
  "ownsPublicSchema",
  "ownsPublicRelations",
  "canCreateDatabase",
  "canCreateSchema",
  "hasRoleMembership",
] as const satisfies ReadonlyArray<keyof RuntimeAuthority>;

/** Whether the runtime role holds any authority forbidden by the production contract. */
export const hasUnsafeAuthority = (authority: RuntimeAuthority): boolean =>
  unsafeAuthorityFields.some((field) => authority[field]);
