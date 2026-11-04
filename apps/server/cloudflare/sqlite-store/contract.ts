import { Schema } from "effect";

export const sqliteStoreLimits = {
  statements: 4096,
  parameters: 100,
  manifestCharacters: 128,
  sqlBytes: 100000,
  requestBytes: 16777216,
  resultBytes: 33554432,
} as const;
const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }));
export const SqliteCell = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Null,
  Schema.Array(Byte),
]);
export const SqliteStatement = Schema.Struct({
  sql: Schema.String.check(Schema.isMaxLength(sqliteStoreLimits.sqlBytes)),
  params: Schema.Array(SqliteCell).check(Schema.isMaxLength(sqliteStoreLimits.parameters)),
});
export const SqliteStoreQuery = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("batch"),
    statements: Schema.Array(SqliteStatement).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(sqliteStoreLimits.statements)
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    statement: SqliteStatement,
    columnNames: Schema.Boolean,
  }),
]);
export type SqliteStoreQuery = typeof SqliteStoreQuery.Type;
export const SqliteStoreRequest = Schema.Struct({
  manifest: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(sqliteStoreLimits.manifestCharacters)
  ),
  query: SqliteStoreQuery,
});
export type SqliteStoreRequest = typeof SqliteStoreRequest.Type;
const Metadata = Schema.Struct({
  duration: Schema.Finite,
  size_after: Schema.Int,
  rows_read: Schema.Int,
  rows_written: Schema.Int,
  last_row_id: Schema.Int,
  changed_db: Schema.Boolean,
  changes: Schema.Int,
});
export const SqliteResult = Schema.Struct({
  success: Schema.Literal(true),
  meta: Metadata,
  results: Schema.Array(Schema.Record(Schema.String, SqliteCell)),
});
export const SqliteStoreReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("batch"), results: Schema.Array(SqliteResult) }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(SqliteCell)),
  }),
  Schema.Struct({
    kind: Schema.Literal("child_refusal"),
    index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
    assertion: Schema.Literals(["guard", "capacity"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("owner_refusal"),
    marker: Schema.Literals([
      "resource_admission_refused",
      "canonical_request_rate",
      "canonical_request_concurrency",
      "commercial_quota_exhausted",
      "commercial_authority_required",
      "recurring_cursor_changed",
      "media_publication_required",
      "media_work_capacity",
      "connection_browser_commit",
      "forwarded_email_deferred_capacity",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["inactive", "invalid", "unavailable"]),
  }),
]);
export type SqliteStoreReply = typeof SqliteStoreReply.Type;
export type SqliteStoreBinding = Readonly<{
  query: (input: SqliteStoreRequest) => Promise<unknown>;
}>;
