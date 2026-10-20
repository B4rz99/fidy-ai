/// <reference types="bun-types" />

import { writeFileSync } from "node:fs";
import { schemaSqlTokens } from "./schema-sql-tokens";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import type { AppliedMigration, HashedMigrationSource, MigrationSource } from "./migration-history";

/** Contains only allowlisted schema names and counts, never SQL, provider output or User rows. */
export class BaselineVerificationError extends Error {}

const maximumDiagnosticObjects = 8;
const baselineName = "0001_schema.sql";
const SchemaObject = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  tbl_name: Schema.String,
  sql: Schema.String,
});
const SchemaReply = Schema.Tuple([
  Schema.Struct({ success: Schema.Literal(true), results: Schema.Array(SchemaObject) }),
]);
const ForeignKeyReply = Schema.Tuple([
  Schema.Struct({
    success: Schema.Literal(true),
    results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
]);
const managedObjects =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN('__alchemy_migrations','d1_migrations') ORDER BY type,name";
type SchemaObject = typeof SchemaObject.Type;
type Query = (sql: string) => string;
const schemaObjects = (source: string): ReadonlyArray<SchemaObject> => {
  const database = new Database(":memory:");
  try {
    database.exec(source);
    const expected = Schema.decodeUnknownSync(Schema.Array(SchemaObject))(
      database.query(managedObjects).all()
    );
    if (!expected.some((row) => row.type === "table" && row.name === "users")) {
      throw new BaselineVerificationError("Baseline schema is incomplete");
    }
    return expected;
  } finally {
    database.close();
  }
};
const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const verifySchema = (query: Query, expected: ReadonlyArray<SchemaObject>): void => {
  const [reply] = Schema.decodeUnknownSync(SchemaReply)(JSON.parse(query(managedObjects)));
  const differences = expected.filter((wanted, index) => {
    const actual = reply.results[index];
    return (
      actual === undefined ||
      actual.type !== wanted.type ||
      actual.name !== wanted.name ||
      actual.tbl_name !== wanted.tbl_name ||
      JSON.stringify(schemaSqlTokens(actual.sql)) !== JSON.stringify(schemaSqlTokens(wanted.sql))
    );
  });
  if (reply.results.length !== expected.length || differences.length > 0) {
    const diagnosticsFile = process.env.SCHEMA_METADATA_FILE;
    if (diagnosticsFile !== undefined) {
      writeFileSync(diagnosticsFile, JSON.stringify({ expected, actual: reply.results }));
    }
    throw new BaselineVerificationError(
      `Production schema differs from baseline (expected ${expected.length} objects, received ${reply.results.length}; differing objects: ${differences
        .slice(0, maximumDiagnosticObjects)
        .map((row) => row.name)
        .join(", ")})`
    );
  }
  const [foreignKeys] = Schema.decodeUnknownSync(ForeignKeyReply)(
    JSON.parse(query("PRAGMA foreign_key_check"))
  );
  if (foreignKeys.results.length !== 0) {
    throw new BaselineVerificationError("Production foreign keys are invalid");
  }
};
const validateHistory = (
  applied: ReadonlyArray<AppliedMigration>,
  target: HashedMigrationSource
): void => {
  if (new Set(applied.map((row) => row.name)).size !== applied.length) {
    throw new BaselineVerificationError("Duplicate migration ledger names");
  }
  if (applied.some((row) => row.name === target.name && row.hash !== target.hash)) {
    throw new BaselineVerificationError("Baseline hash mismatch");
  }
};
const requireBaseline = (
  rows: ReadonlyArray<AppliedMigration>,
  target: HashedMigrationSource
): void => {
  if (rows.length !== 1 || rows[0].name !== target.name || rows[0].hash !== target.hash) {
    throw new BaselineVerificationError("Baseline ledger verification failed");
  }
};

/** Adopt only an already matching schema. Insert the replacement ledger row before retiring history,
 * so interrupted metadata updates can resume without an empty ledger. No baseline DDL runs remotely.
 */
export const adoptSchemaBaseline = ({
  sources,
  checkedIn,
  applied,
  query,
  ledger,
}: Readonly<{
  sources: ReadonlyArray<MigrationSource>;
  checkedIn: ReadonlyArray<HashedMigrationSource>;
  applied: ReadonlyArray<AppliedMigration>;
  query: Query;
  ledger: () => ReadonlyArray<AppliedMigration>;
}>): ReadonlyArray<AppliedMigration> => {
  if (sources.length !== 1 || checkedIn.length !== 1) {
    return applied;
  }
  const source = sources[0];
  const target = checkedIn[0];
  if (source.name !== baselineName || target.name !== baselineName) {
    return applied;
  }
  if (applied.length === 0) {
    return applied;
  }
  if (applied.every((row) => row.name === baselineName)) {
    return applied;
  }
  validateHistory(applied, target);
  const expected = schemaObjects(source.source);
  verifySchema(query, expected);
  query(
    `INSERT INTO __alchemy_migrations(hash,created_at,name,applied_at) SELECT ${sqlLiteral(target.hash)},NULL,${sqlLiteral(baselineName)},datetime('now') WHERE NOT EXISTS(SELECT 1 FROM __alchemy_migrations WHERE name=${sqlLiteral(baselineName)})`
  );
  requireBaseline(
    ledger().filter((row) => row.name === baselineName),
    target
  );
  verifySchema(query, expected);
  query(`DELETE FROM __alchemy_migrations WHERE name<>${sqlLiteral(baselineName)}`);
  const adopted = ledger();
  requireBaseline(adopted, target);
  verifySchema(query, expected);
  return adopted;
};
