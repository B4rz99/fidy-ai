import { resolveDatabase } from "./internal/target";
import type { AuthoritativeStoreEnvironment, SqliteStoreBinding } from "./contract";
import { remoteDatabase } from "./internal/remote";
import { sqliteDatabase, sqliteDatabaseUnit } from "./internal/database";

/** Local adapter only: SQL never crosses the Store's private Worker boundary. */
export const makeSqliteDatabase = (storage: DurableObjectStorage): D1Database =>
  sqliteDatabase(storage);

/** Existing owner-prepared statements may participate in a larger synchronous native unit. */
export const makeSqliteDatabaseUnit = (
  storage: DurableObjectStorage
): ReturnType<typeof sqliteDatabaseUnit> => sqliteDatabaseUnit(storage);

/** Private binding transport; callers cannot choose a physical target or issue SQL over HTTP. */
export const makeRemoteSqliteDatabase = (
  input: Readonly<{ store: SqliteStoreBinding; manifest: string; epoch: string }>
): D1Database => remoteDatabase(input);

/** Fail closed for absent or competing target bindings, without touching either store. */
export const resolveAuthoritativeDatabase = (
  environment: AuthoritativeStoreEnvironment
): D1Database => resolveDatabase(environment);

/** Native composition roots resolve once, then apply the existing recovery guard to that target. */
export const withAuthoritativeStore = <Environment extends AuthoritativeStoreEnvironment>(
  environment: Environment
): Omit<Environment, "DB" | "SQLITE_STORE" | "SQLITE_STORE_MANIFEST" | "SQLITE_STORE_EPOCH"> &
  Readonly<{ DB: D1Database }> => ({
  ...environment,
  DB: resolveDatabase(environment),
  SQLITE_STORE: undefined,
  SQLITE_STORE_MANIFEST: undefined,
  SQLITE_STORE_EPOCH: undefined,
});
