import type { SqliteStoreBinding } from "./contract";
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
  input: Readonly<{ store: SqliteStoreBinding; manifest: string }>
): D1Database => remoteDatabase(input);
