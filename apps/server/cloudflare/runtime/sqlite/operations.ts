import type * as Sql from "effect/sql/SqlClient";
import { SqliteClient, layer } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, ManagedRuntime, Schema } from "effect";

/** Install one owner's empty schema and version atomically before allowing requests. */
export const openSqliteStore = Effect.fnUntraced(function* (schema: ReadonlyArray<string>) {
  const sql = yield* SqliteClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS store_schema(version INTEGER PRIMARY KEY) STRICT`;
      const markers = yield* sql`SELECT version FROM store_schema LIMIT 2`;
      if (markers.length > 0) {
        yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ version: Schema.Literal(1) })])
        )(markers);
        return;
      }
      for (const statement of schema) yield* sql.unsafe(statement);
      yield* sql`INSERT INTO store_schema VALUES (1)`;
    })
  );
});

export const createStoreRuntime = (
  storage: DurableObjectStorage
): ManagedRuntime.ManagedRuntime<SqliteClient | Sql.SqlClient, never> =>
  ManagedRuntime.make(layer({ storage }));
