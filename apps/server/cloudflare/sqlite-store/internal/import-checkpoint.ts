import { Option, Schema } from "effect";
import { RecoveryBootstrapAuthorization, RecoveryTarget } from "../../recovery-activation/contract";
import { SnapshotDigest, SnapshotManifest } from "../../sqlite-snapshot/contract";
import type { SqliteImportInput } from "../contract";

export const ImportCheckpoint = Schema.Struct({
  phase: Schema.Literals(["Importing", "ErasureVerification"]),
  stage: Schema.Literals([
    "Tables",
    "Data",
    "Sequences",
    "Views",
    "Objects",
    "ForeignKeys",
    "Complete",
  ]),
  activationId: Schema.String.check(Schema.isUUID()),
  artifactDigest: SnapshotDigest,
  authorization: RecoveryBootstrapAuthorization,
  manifest: SnapshotManifest,
  head: Schema.OptionFromNullOr(SnapshotDigest),
  copiedRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  schemaObjects: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ImportCheckpoint = typeof ImportCheckpoint.Type;
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCheckpoint = Schema.encodeSync(Schema.fromJsonString(ImportCheckpoint));
const encodeAuthorization = Schema.encodeSync(
  Schema.fromJsonString(RecoveryBootstrapAuthorization)
);
export const assertImport = (input: SqliteImportInput): void => {
  const candidate: unknown = {
    namespaceId: input.environment.SQLITE_STORE_NAMESPACE_ID,
    objectId: input.state.id.toString(),
    manifest: input.environment.SQLITE_STORE_MANIFEST,
    epoch: input.environment.SQLITE_STORE_EPOCH,
  };
  const actual = Schema.decodeUnknownSync(RecoveryTarget)(candidate);
  const authorization = Schema.decodeSync(RecoveryBootstrapAuthorization)(input.authorization);
  if (
    encode(actual) !== encode(authorization.target) ||
    authorization.artifactDigest !== input.environment.SQLITE_STORE_ARTIFACT_DIGEST ||
    input.state.storage.kv.get("store-seal") !== undefined
  ) {
    throw Error("Inactive import unavailable");
  }
  const admission: unknown = input.state.storage.kv.get("store-admission");
  if (
    admission !== undefined &&
    encode(admission) !==
      encode({
        phase: "Closed",
        activationId: authorization.evidence.activationId,
        epoch: actual.epoch,
      })
  ) {
    throw Error("Inactive import unavailable");
  }
};
export const currentCheckpoint = (input: SqliteImportInput): Option.Option<ImportCheckpoint> => {
  assertImport(input);
  const raw: unknown = input.state.storage.kv.get("store-bootstrap");
  if (raw === undefined) return Option.none();
  const checkpoint = Schema.decodeUnknownSync(ImportCheckpoint)(raw);
  if (encodeAuthorization(checkpoint.authorization) !== encodeAuthorization(input.authorization)) {
    throw Error("Inactive import unavailable");
  }
  return Option.some(checkpoint);
};
export const assertCheckpoint = (
  input: Readonly<{ import: SqliteImportInput; checkpoint: ImportCheckpoint }>
): void => {
  const latest = currentCheckpoint(input.import);
  if (
    Option.isNone(latest) ||
    encodeCheckpoint(latest.value) !== encodeCheckpoint(input.checkpoint)
  ) {
    throw Error("Import checkpoint changed");
  }
};
