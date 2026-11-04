import { Schema } from "effect";
import {
  SqliteStatement,
  type SqliteStoreBinding,
  SqliteStoreQuery,
  SqliteStoreReply,
} from "../contract";

const unavailable = (): never => {
  throw new Error("Authoritative store unavailable");
};
const databasePrototype: D1Database = {
  prepare: unavailable,
  batch: unavailable,
  exec: unavailable,
  dump: unavailable,
  withSession: unavailable,
};
const statementPrototype: D1PreparedStatement = {
  bind: unavailable,
  all: unavailable,
  first: unavailable,
  run: unavailable,
  raw: unavailable,
};
const normalize = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return value;
};
const receive = (candidate: unknown): SqliteStoreReply => {
  const reply = Schema.decodeUnknownSync(SqliteStoreReply)(candidate);
  if (reply.kind === "refused") throw new Error(`Authoritative store ${reply.reason}`);
  if (reply.kind === "owner_refusal") {
    throw new Error(
      `D1_ERROR: ${reply.marker}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
    );
  }
  if (reply.kind === "child_refusal") {
    throw new Error(
      `D1_ERROR: CHECK constraint failed: canonical_child_${reply.assertion}_${reply.index}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)`
    );
  }
  return reply;
};
const send =
  (configuration: Readonly<{ store: SqliteStoreBinding; manifest: string }>) =>
  (input: unknown): Promise<SqliteStoreReply> =>
    Promise.resolve()
      .then(() => Schema.decodeUnknownSync(SqliteStoreQuery)(input))
      .then((query) => configuration.store.query({ manifest: configuration.manifest, query }))
      .then(receive);
const rawReply = (reply: SqliteStoreReply, names: boolean): unknown => {
  if (reply.kind !== "raw") return unavailable();
  return names ? [reply.columns, ...reply.rows] : reply.rows;
};
const firstReply = (reply: SqliteStoreReply, column?: string): unknown => {
  if (reply.kind !== "batch") return unavailable();
  const row = reply.results[0]?.results[0];
  if (row === undefined) return null;
  if (column === undefined) return row;
  if (!(column in row)) return unavailable();
  return row[column];
};
const batchReply = (reply: SqliteStoreReply): unknown =>
  reply.kind === "batch" ? reply.results : unavailable();

const statements = (
  execute: ReturnType<typeof send>
): Readonly<{
  prepare: (description: typeof SqliteStatement.Type) => D1PreparedStatement;
  descriptions: WeakMap<D1PreparedStatement, typeof SqliteStatement.Type>;
}> => {
  const descriptions = new WeakMap<D1PreparedStatement, typeof SqliteStatement.Type>();
  const prepare = (description: typeof SqliteStatement.Type): D1PreparedStatement => {
    const one = (): Promise<SqliteStoreReply> =>
      execute({ kind: "batch", statements: [description] });
    const statement = new Proxy(statementPrototype, {
      get(target, key, receiver): unknown {
        if (key === "bind") {
          return (...params: unknown[]) =>
            prepare(
              Schema.decodeUnknownSync(SqliteStatement)({
                sql: description.sql,
                params: params.map(normalize),
              })
            );
        }
        if (key === "all" || key === "run") {
          return () =>
            one().then((reply) => (reply.kind === "batch" ? reply.results[0] : unavailable()));
        }
        if (key === "first") {
          return (column?: string) => one().then((reply) => firstReply(reply, column));
        }
        if (key === "raw") {
          return (options?: { columnNames: true } | Parameters<D1PreparedStatement["raw"]>[0]) =>
            execute({
              kind: "raw",
              statement: description,
              columnNames: options?.columnNames === true,
            }).then((reply) => rawReply(reply, options?.columnNames === true));
        }
        return Reflect.get(target, key, receiver);
      },
    });
    descriptions.set(statement, description);
    return statement;
  };
  return { prepare, descriptions };
};

export const remoteDatabase = (
  input: Readonly<{ store: SqliteStoreBinding; manifest: string }>
): D1Database => {
  const execute = send(input);
  const { prepare, descriptions } = statements(execute);
  const batch = (statements: D1PreparedStatement[]): Promise<unknown> =>
    Promise.resolve()
      .then(() =>
        statements.map((statement) => {
          const description = descriptions.get(statement);
          if (description === undefined) return unavailable();
          return description;
        })
      )
      .then((statements) => execute({ kind: "batch", statements }))
      .then(batchReply);
  return new Proxy(databasePrototype, {
    get(target, key, receiver): unknown {
      if (key === "prepare") return (sql: string) => prepare({ sql, params: [] });
      if (key === "batch") return batch;
      if (key === "exec") {
        return (sql: string) => {
          const statements = sql
            .split("\n")
            .map((sql) => sql.trim())
            .filter((sql) => sql.length > 0)
            .map((sql) => ({ sql, params: [] }));
          return execute({ kind: "batch", statements }).then(() => ({
            count: statements.length,
            duration: 0,
          }));
        };
      }
      if (key === "withSession") {
        return () => ({
          prepare: (sql: string) => prepare({ sql, params: [] }),
          batch,
          getBookmark: () => null,
        });
      }
      return Reflect.get(target, key, receiver);
    },
  });
};
