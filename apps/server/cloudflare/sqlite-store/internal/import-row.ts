import { Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { type SnapshotCell, type SnapshotDataNode } from "../../sqlite-snapshot/contract";

const maximumColumns = 99;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const columns = (input: Readonly<{ sql: SqlStorage; table: string }>): ReadonlyArray<string> => {
  const rows = input.sql
    .exec("SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid", input.table)
    .toArray();
  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(rows).map(
    (row) => row.name
  );
};
const binding = (cell: SnapshotCell): SqlStorageValue => {
  if (cell.kind === "null") return null;
  if (cell.kind === "blob") return new Uint8Array(Result.getOrThrow(Hex.decode(cell.value))).buffer;
  if (cell.kind === "real") {
    const value = Number(cell.value);
    if (!Number.isFinite(value)) throw Error("Unrepresentable native real");
    return value;
  }
  return cell.value;
};
const argument = (cell: SnapshotCell): string =>
  cell.kind === "integer" ? "CAST(? AS INTEGER)" : "?";
const projection = (column: string, index: number): string => {
  const name = quote(column);
  return `typeof(${name}) AS k${index},CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT) WHEN 'real' THEN printf('%!.17g',${name}) WHEN 'blob' THEN lower(hex(${name})) ELSE ${name} END AS v${index}`;
};
/** SQL and the enclosing local checkpoint commit together. Triggers are installed only after all copied rows. */
export const importRow = (
  input: Readonly<{ sql: SqlStorage; row: typeof SnapshotDataNode.Type }>
): void => {
  const names = columns({ sql: input.sql, table: input.row.table });
  if (
    names.length !== input.row.cells.length ||
    names.length > maximumColumns ||
    names.includes("_rowid_")
  ) {
    throw Error("Import row shape mismatch");
  }
  const statement = `INSERT INTO ${quote(input.row.table)}(_rowid_,${names.map(quote).join(",")}) VALUES(CAST(? AS INTEGER),${input.row.cells.map(argument).join(",")})`;
  input.sql.exec(statement, input.row.rowid, ...input.row.cells.map(binding)).toArray();
  const rows = input.sql
    .exec(
      `SELECT ${names.map(projection).join(",")} FROM ${quote(input.row.table)} WHERE _rowid_=CAST(? AS INTEGER)`,
      input.row.rowid
    )
    .toArray();
  const result = rows[0];
  if (result === undefined || rows.length !== 1) throw Error("Import row verification failed");
  verifyCells({ result, cells: input.row.cells });
};
const verifyCells = (
  input: Readonly<{ result: Record<string, SqlStorageValue>; cells: ReadonlyArray<SnapshotCell> }>
): void => {
  for (const [index, cell] of input.cells.entries()) {
    if (
      input.result[`k${index}`] !== cell.kind ||
      (cell.kind !== "null" && input.result[`v${index}`] !== cell.value)
    ) {
      throw Error("Import cell verification failed");
    }
  }
};
