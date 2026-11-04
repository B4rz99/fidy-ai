import { Schema } from "effect";

const ByteArray = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })));
const Binding = Schema.Union([Schema.String, Schema.Finite, Schema.Null]);
const outputValue = (value: SqlStorageValue): SqlStorageValue | number[] =>
  value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value;
const outputRow = (
  row: Record<string, SqlStorageValue>
): Record<string, SqlStorageValue | number[]> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, outputValue(value)]));
type Preparation = Readonly<{ query: string; bindings: ReadonlyArray<SqlStorageValue> }>;
const unavailable = (): never => {
  throw new Error("Unsupported SQLite adapter operation");
};
const statementPrototype: D1PreparedStatement = {
  bind: unavailable,
  first: unavailable,
  all: unavailable,
  run: unavailable,
  raw: unavailable,
};
const databasePrototype: D1Database = {
  prepare: unavailable,
  batch: unavailable,
  exec: unavailable,
  dump: unavailable,
  withSession: unavailable,
};
const binding = (value: unknown): SqlStorageValue => {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  if (Array.isArray(value)) {
    return new Uint8Array(Schema.decodeSync(ByteArray)(value)).buffer;
  }
  return Schema.decodeUnknownSync(Binding)(value);
};
const promise = <A>(execute: () => A): Promise<A> => {
  try {
    return Promise.resolve(execute());
  } catch (error) {
    return Promise.reject(error);
  }
};
const Status = Schema.Struct({ total: Schema.Int, rowId: Schema.Int });
const status = (sql: SqlStorage): typeof Status.Type =>
  Schema.decodeUnknownSync(Status)(
    sql.exec("SELECT total_changes() AS total,last_insert_rowid() AS rowId").one()
  );
const execute = (storage: DurableObjectStorage, prepared: Preparation): D1Result => {
  const before = status(storage.sql);
  const sizeBefore = storage.sql.databaseSize;
  const cursor = storage.sql.exec(prepared.query, ...prepared.bindings);
  const results = cursor.toArray().map(outputRow);
  const counters = status(storage.sql);
  const changes = counters.total - before.total;
  return {
    success: true,
    results,
    meta: {
      // SqlStorage supplies no execution-duration metric; do not treat this as measured CPU time.
      duration: 0,
      size_after: storage.sql.databaseSize,
      rows_read: cursor.rowsRead,
      rows_written: cursor.rowsWritten,
      last_row_id: counters.rowId,
      changed_db:
        changes !== 0 || counters.rowId !== before.rowId || sizeBefore !== storage.sql.databaseSize,
      changes,
    },
  };
};
const raw = (storage: DurableObjectStorage, prepared: Preparation, names: boolean): unknown => {
  const cursor = storage.sql.exec(prepared.query, ...prepared.bindings);
  const rows = Array.from(cursor.raw(), (row) => row.map(outputValue));
  return names ? [cursor.columnNames, ...rows] : rows;
};
const first = (storage: DurableObjectStorage, prepared: Preparation, column?: string): unknown => {
  const row = storage.sql.exec(prepared.query, ...prepared.bindings).toArray()[0];
  if (row === undefined) return null;
  if (column === undefined) return outputRow(row);
  if (!(column in row)) throw new Error("Requested SQLite column is absent");
  const value = row[column];
  return value === undefined ? null : outputValue(value);
};
const execLines = (storage: DurableObjectStorage, query: string): Promise<D1ExecResult> =>
  promise(() =>
    storage.transactionSync(() => {
      const lines = query
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) throw new Error("No SQL statements detected");
      for (const line of lines) storage.sql.exec(line).toArray();
      return { count: lines.length, duration: 0 };
    })
  );

export const sqliteDatabase = (storage: DurableObjectStorage): D1Database => {
  const preparations = new WeakMap<D1PreparedStatement, Preparation>();
  const prepare = (prepared: Preparation): D1PreparedStatement => {
    const statement = new Proxy(statementPrototype, {
      get(target, key, receiver): unknown {
        if (key === "bind") {
          return (...values: unknown[]) =>
            prepare({ query: prepared.query, bindings: values.map(binding) });
        }
        if (key === "all" || key === "run") {
          return () => promise(() => storage.transactionSync(() => execute(storage, prepared)));
        }
        if (key === "first") {
          return (column?: string) =>
            promise(() => storage.transactionSync(() => first(storage, prepared, column)));
        }
        if (key === "raw") {
          return (options?: { columnNames: true } | Parameters<D1PreparedStatement["raw"]>[0]) =>
            promise(() =>
              storage.transactionSync(() => raw(storage, prepared, options?.columnNames === true))
            );
        }
        return Reflect.get(target, key, receiver);
      },
    });
    preparations.set(statement, prepared);
    return statement;
  };
  return new Proxy(databasePrototype, {
    get(target, key, receiver): unknown {
      if (key === "prepare") return (query: string) => prepare({ query, bindings: [] });
      if (key === "exec") return (query: string) => execLines(storage, query);
      if (key === "batch") {
        return (statements: D1PreparedStatement[]) =>
          promise(() =>
            storage.transactionSync(() => {
              if (statements.length === 0) throw new Error("No SQL statements detected");
              return statements.map((statement) => {
                const prepared = preparations.get(statement);
                if (prepared === undefined) {
                  throw new Error("Statement belongs to another database");
                }
                return execute(storage, prepared);
              });
            })
          );
      }
      if (key === "withSession") {
        return () => ({
          prepare: receiver.prepare,
          batch: receiver.batch,
          getBookmark: () => null,
        });
      }
      return Reflect.get(target, key, receiver);
    },
  });
};
