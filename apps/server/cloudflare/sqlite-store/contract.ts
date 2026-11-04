import type {
  RecoveryBootstrapAuthorization,
  RecoveryTarget,
} from "../recovery-activation/contract";
import { type Effect, Schema } from "effect";
import type { SnapshotArtifact, SnapshotUnavailable } from "../sqlite-snapshot/contract";

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
  epoch: Schema.String.check(
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
    reason: Schema.Literals(["inactive", "invalid", "unavailable", "closed"]),
  }),
]);
export type SqliteStoreReply = typeof SqliteStoreReply.Type;
export type SqliteStoreBinding = Readonly<{
  query: (input: SqliteStoreRequest) => Promise<unknown>;
}>;

export type AuthoritativeStoreEnvironment = Partial<
  Readonly<{
    DB: D1Database;
    SQLITE_STORE: Readonly<{ getByName: (name: string) => SqliteStoreBinding }>;
    SQLITE_STORE_MANIFEST: string;
    SQLITE_STORE_EPOCH: string;
  }>
>;

export const SqliteStoreControlRequest = Schema.Struct({
  activationId: SqliteStoreRequest.fields.manifest,
  epoch: SqliteStoreRequest.fields.manifest,
});
export const SqliteStoreControlQuery = Schema.Struct({
  ...SqliteStoreControlRequest.fields,
  query: SqliteStoreQuery,
});
export const SqliteStoreObservation = Schema.Struct({
  target: Schema.Struct({
    namespaceId: Schema.String,
    objectId: Schema.String,
    manifest: SqliteStoreRequest.fields.manifest,
    epoch: SqliteStoreRequest.fields.manifest,
  }),
  admission: Schema.Literals(["Open", "Closed"]),
  activationId: Schema.String,
  ownerVersion: Schema.String,
  queryLeases: Schema.Literal(0),
  releaseBarrier: Schema.Literal("Unqualified"),
});
export type SqliteStoreObservation = typeof SqliteStoreObservation.Type;
export type SqliteStoreControlReply =
  | SqliteStoreObservation
  | Readonly<{ kind: "refused"; reason: "inactive" | "invalid" | "closed" }>;
export type SqliteStoreControlBinding = Readonly<{
  inspect: () => Promise<unknown>;
  close: (input: typeof SqliteStoreControlRequest.Type) => Promise<unknown>;
  controlQuery: (input: typeof SqliteStoreControlQuery.Type) => Promise<unknown>;
}>;

export type SqliteStoreEnvironment = Partial<
  Readonly<{
    SQLITE_STORE_MANIFEST: string;
    SQLITE_STORE_EPOCH: string;
    SQLITE_STORE_NAMESPACE_ID: string;
    SQLITE_STORE_ARTIFACT_DIGEST: string;
    SQLITE_STORE_ACTIVATION_ID: string;
    SQLITE_STORE_ARTIFACTS: R2Bucket;
    CF_VERSION_METADATA: Readonly<{ id: string }>;
    ERASURE_BUCKET: R2Bucket;
    BROWSER_ORIGIN: string;
  }>
>;

/** Captured local bootstrap control. It grants no serving or provider qualification; every native unit rechecks inactivity after external I/O. */
export type SqliteBootstrapTarget = Readonly<{
  storage: DurableObjectStorage;
  objectId: string;
  target: RecoveryTarget;
  activationId: string;
  artifactDigest: string;
  assertInactive: () => void;
}>;
export type SqliteBootstrapTargetInput = Readonly<{
  state: DurableObjectState;
  environment: SqliteStoreEnvironment;
  activationId: string;
}>;

/** Local-only importer input: composition supplies the recovery owner's authorization for one fixed inactive deployment target. */
export type SqliteImportInput = Readonly<{
  state: DurableObjectState;
  environment: SqliteStoreEnvironment;
  readArtifact: (digest: string) => Effect.Effect<SnapshotArtifact, SnapshotUnavailable>;
  authorization: RecoveryBootstrapAuthorization;
}>;
export type SqliteImportStatus = Readonly<{
  phase: "Importing" | "ErasureVerification";
  stage: string;
  copiedRows: number;
  schemaObjects: number;
}>;
