import { sqliteDatabase } from "./internal/database";

/** Local adapter only: SQL never crosses the Store's private Worker boundary. */
export const makeSqliteDatabase = (storage: DurableObjectStorage): D1Database =>
  sqliteDatabase(storage);
