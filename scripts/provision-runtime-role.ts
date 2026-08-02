#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Config, Data, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { hasUnsafeAuthority, readRuntimeAuthority } from "~/shell/db/runtime-authority";

class InvalidDatabaseUrl extends Data.TaggedError("InvalidDatabaseUrl")<{
  readonly message: string;
}> {}

class UnsafeRuntimeRole extends Data.TaggedError("UnsafeRuntimeRole")<{
  readonly message: string;
}> {}

const databaseTarget = (url: URL): string =>
  `${url.protocol}//${url.hostname}:${url.port || "5432"}${url.pathname}`;

const parseDatabaseUrl = (
  name: string,
  value: Redacted.Redacted
): Effect.Effect<URL, InvalidDatabaseUrl> =>
  Effect.try({
    try: () => new URL(Redacted.value(value)),
    catch: () => new InvalidDatabaseUrl({ message: `${name} must be a valid PostgreSQL URL.` }),
  }).pipe(
    Effect.filterOrFail(
      (url) =>
        (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
        url.pathname.length > 1 &&
        url.search.length === 0 &&
        url.hash.length === 0,
      () =>
        new InvalidDatabaseUrl({
          message: `${name} must be a PostgreSQL URL with an explicit database and without query parameters or fragments.`,
        })
    )
  );

const decodeCredential = (name: string, value: string): Effect.Effect<string, InvalidDatabaseUrl> =>
  Effect.try({
    try: () => decodeURIComponent(value),
    catch: () => new InvalidDatabaseUrl({ message: `${name} contains invalid percent encoding.` }),
  });

const provisionRuntimeRole = (runtimePassword: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        DO $provision$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fidy_runtime'
          ) THEN
            CREATE ROLE fidy_runtime
              NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;

          REVOKE CREATE ON SCHEMA public FROM PUBLIC;
          EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
        END
        $provision$
      `;

        const initialAuthority = yield* readRuntimeAuthority(sql);
        if (hasUnsafeAuthority(initialAuthority)) {
          return yield* new UnsafeRuntimeRole({
            message: "fidy_runtime already has forbidden database authority.",
          });
        }

        yield* sql`SELECT set_config('fidy.runtime_role_password', ${runtimePassword}, true)`;
        yield* sql`
        DO $password$
        BEGIN
          EXECUTE format(
            'ALTER ROLE fidy_runtime WITH LOGIN PASSWORD %L',
            current_setting('fidy.runtime_role_password')
          );
        END
        $password$
      `;

        const finalAuthority = yield* readRuntimeAuthority(sql);
        if (!finalAuthority.canLogin || hasUnsafeAuthority(finalAuthority)) {
          return yield* new UnsafeRuntimeRole({
            message: "The provisioned fidy_runtime role is not restricted.",
          });
        }
      })
    );
  }).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

const ProvisionLive = Layer.unwrap(
  Effect.gen(function* () {
    const urls = yield* Config.all({
      migration: Config.redacted("MIGRATION_DATABASE_URL"),
      runtime: Config.redacted("DATABASE_URL"),
    });
    const migrationUrl = yield* parseDatabaseUrl("MIGRATION_DATABASE_URL", urls.migration);
    const runtimeUrl = yield* parseDatabaseUrl("DATABASE_URL", urls.runtime);
    const runtimeUser = yield* decodeCredential("DATABASE_URL username", runtimeUrl.username);
    const runtimePassword = yield* decodeCredential("DATABASE_URL password", runtimeUrl.password);

    if (runtimeUser !== "fidy_runtime") {
      return yield* new InvalidDatabaseUrl({
        message: "DATABASE_URL must authenticate as fidy_runtime.",
      });
    }
    if (runtimePassword.length === 0) {
      return yield* new InvalidDatabaseUrl({
        message: "DATABASE_URL must include the fidy_runtime password.",
      });
    }
    if (databaseTarget(runtimeUrl) !== databaseTarget(migrationUrl)) {
      return yield* new InvalidDatabaseUrl({
        message:
          "DATABASE_URL and MIGRATION_DATABASE_URL must target the same PostgreSQL database.",
      });
    }

    return Layer.effectDiscard(provisionRuntimeRole(runtimePassword)).pipe(
      Layer.provide(PgClient.layer({ url: urls.migration }))
    );
  })
);

BunRuntime.runMain(Effect.scoped(Layer.build(ProvisionLive)));
