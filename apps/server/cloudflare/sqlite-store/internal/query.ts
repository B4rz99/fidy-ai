import { Schema } from "effect";
import { SqliteStoreQuery, SqliteStoreReply, sqliteStoreLimits } from "../contract";
import { sqliteDatabaseUnit } from "./database";

const encodedJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const bytes = (input: Schema.Json): number =>
  new TextEncoder().encode(encodedJson(input)).byteLength;
const decodeReply = Schema.decodeUnknownSync(SqliteStoreReply);
const statementBytes = (input: SqliteStoreQuery): number => {
  const statements = input.kind === "batch" ? input.statements : [input.statement];
  for (const statement of statements) {
    if (new TextEncoder().encode(statement.sql).byteLength > sqliteStoreLimits.sqlBytes) {
      throw new Error("SQLite statement exceeds transport budget");
    }
  }
  return bytes(input);
};
const constraintReply = (error: unknown): SqliteStoreReply => {
  const text = error instanceof Error ? error.message : "";
  const child =
    /^CHECK constraint failed: canonical_child_(guard|capacity)_(0|[1-9]|10|11): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_CHECK\)$/u.exec(
      text
    );
  if (child !== null) {
    return decodeReply({ kind: "child_refusal", index: Number(child[2]), assertion: child[1] });
  }
  const marker = /^(\w+): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)$/u.exec(text);
  if (marker !== null) {
    const reply = Schema.decodeUnknownOption(SqliteStoreReply)({
      kind: "owner_refusal",
      marker: marker[1],
    });
    if (reply._tag === "Some") return reply.value;
  }
  return { kind: "refused", reason: "unavailable" };
};

/** Synchronous validation remains inside the outer rollback boundary, including reply-size refusal. */
export const executeStoreQuery = ({
  storage,
  candidate,
}: Readonly<{ storage: DurableObjectStorage; candidate: unknown }>): SqliteStoreReply => {
  const input = Schema.decodeUnknownOption(SqliteStoreQuery)(candidate);
  if (input._tag === "None") return { kind: "refused", reason: "invalid" };
  try {
    if (statementBytes(input.value) > sqliteStoreLimits.requestBytes) {
      return { kind: "refused", reason: "invalid" };
    }
    return storage.transactionSync(() => {
      const unit = sqliteDatabaseUnit(storage);
      const query = input.value;
      if (query.kind === "raw") {
        const cursor = storage.sql.exec(
          query.statement.sql,
          ...query.statement.params.map((value) =>
            Array.isArray(value) ? new Uint8Array(value).buffer : value
          )
        );
        const rows = Array.from(cursor.raw(), (row) =>
          row.map((value) =>
            value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value
          )
        );
        return checkedReply({
          kind: "raw",
          columns: query.columnNames ? cursor.columnNames : [],
          rows,
        });
      }
      return checkedReply({
        kind: "batch",
        results: unit.run(
          query.statements.map((statement) =>
            unit.database.prepare(statement.sql).bind(...statement.params)
          )
        ),
      });
    });
  } catch (error) {
    return constraintReply(error);
  }
};
const checkedReply = (candidate: unknown): SqliteStoreReply => {
  const reply = decodeReply(candidate);
  if (bytes(reply) > sqliteStoreLimits.resultBytes) {
    throw new Error("SQLite result exceeds transport budget");
  }
  return reply;
};
