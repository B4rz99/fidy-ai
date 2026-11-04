import { Effect, Option, Schema } from "effect";
import { RecoveryBootstrapAuthorization } from "../../recovery-activation/contract";
import {
  type SnapshotArtifact,
  type SnapshotSchemaObject,
  SnapshotUnavailable,
} from "../../sqlite-snapshot/contract";
import type { SqliteImportInput, SqliteImportStatus } from "../contract";
import {
  ImportCheckpoint,
  assertCheckpoint,
  assertImport,
  currentCheckpoint,
} from "./import-checkpoint";
import { importRow } from "./import-row";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const foreignKeys = (
  input: Readonly<{ storage: DurableObjectStorage; enabled: boolean }>
): void => {
  input.storage.sql.exec(`PRAGMA foreign_keys=${input.enabled ? "ON" : "OFF"}`).toArray();
  const [row] = input.storage.sql.exec("PRAGMA foreign_keys").toArray();
  if (row?.foreign_keys !== Number(input.enabled)) {
    throw Error("Native foreign-key mode unavailable");
  }
};
const save = (
  input: Readonly<{ import: SqliteImportInput; checkpoint: ImportCheckpoint }>
): void => {
  input.import.state.storage.kv.put(
    "store-bootstrap",
    Schema.encodeSync(ImportCheckpoint)(input.checkpoint)
  );
};
const initialize = (
  input: SqliteImportInput
): Effect.Effect<ImportCheckpoint, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const authorization = yield* Schema.decodeEffect(RecoveryBootstrapAuthorization)(
      input.authorization
    );
    const manifest = yield* input.readArtifact(authorization.artifactDigest);
    if (
      manifest.kind !== "manifest" ||
      encode(manifest.evidence) !== encode(authorization.evidence) ||
      encode(manifest.target) !== encode(authorization.target)
    ) {
      return yield* new SnapshotUnavailable();
    }
    const checkpoint: ImportCheckpoint = {
      phase: "Importing",
      stage: "Tables",
      authorization,
      manifest,
      activationId: authorization.evidence.activationId,
      artifactDigest: authorization.artifactDigest,
      head: manifest.schemaHead,
      copiedRows: 0,
      schemaObjects: 0,
    };
    assertImport(input);
    if (Option.isSome(currentCheckpoint(input))) return yield* new SnapshotUnavailable();
    const existing = input.state.storage.sql
      .exec(
        "SELECT name FROM sqlite_schema WHERE name NOT GLOB '__cf_*' AND name NOT GLOB '_cf_*' LIMIT 1"
      )
      .toArray();
    if (existing.length !== 0) return yield* new SnapshotUnavailable();
    foreignKeys({ storage: input.state.storage, enabled: false });
    input.state.storage.transactionSync(() => {
      assertImport(input);
      input.state.storage.kv.put("store-admission", {
        phase: "Closed",
        activationId: checkpoint.activationId,
        epoch: authorization.target.epoch,
      });
      save({ import: input, checkpoint });
    });
    return checkpoint;
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const nextStage = (
  input: Readonly<{ import: SqliteImportInput; checkpoint: ImportCheckpoint }>
): ImportCheckpoint => {
  const retained = input.checkpoint;
  switch (retained.stage) {
    case "Tables":
      return { ...retained, stage: "Data", head: retained.manifest.dataHead };
    case "Data":
      input.import.state.storage.sql.exec("DELETE FROM sqlite_sequence").toArray();
      return { ...retained, stage: "Sequences", head: retained.manifest.dataHead };
    case "Sequences":
      return { ...retained, stage: "Views", head: retained.manifest.schemaHead };
    case "Views":
      return { ...retained, stage: "Objects", head: retained.manifest.schemaHead };
    case "Objects":
      return { ...retained, stage: "ForeignKeys", head: retained.manifest.schemaHead };
    case "ForeignKeys":
    case "Complete":
      throw Error("Invalid import stage");
  }
};
const schemaSelected = (
  input: Readonly<{
    stage: Exclude<ImportCheckpoint["stage"], "Data" | "Sequences">;
    object: SnapshotSchemaObject;
  }>
): boolean => {
  switch (input.stage) {
    case "Tables":
      return input.object.type === "table" && input.object.name !== "sqlite_sequence";
    case "Views":
      return input.object.type === "view";
    case "Objects":
      return input.object.type === "index" || input.object.type === "trigger";
    case "Complete":
    case "ForeignKeys":
      return false;
  }
};
const apply = (
  input: Readonly<{
    import: SqliteImportInput;
    checkpoint: ImportCheckpoint;
    node: SnapshotArtifact;
  }>
): ImportCheckpoint => {
  const { checkpoint: retained, node } = input;
  const sql = input.import.state.storage.sql;
  if (retained.stage === "Data" || retained.stage === "Sequences") {
    if (node.kind !== "data") throw Error("Invalid data chain");
    if ((retained.stage === "Sequences") === (node.table === "sqlite_sequence")) {
      importRow({ sql, row: node });
    }
    return {
      ...retained,
      head: node.previous,
      copiedRows: retained.copiedRows + Number(retained.stage === "Data"),
    };
  }
  if (node.kind !== "schema") throw Error("Invalid schema chain");
  const selected = schemaSelected({ stage: retained.stage, object: node.object });
  if (selected) sql.exec(node.object.sql).toArray();
  return {
    ...retained,
    head: node.previous,
    schemaObjects: retained.schemaObjects + Number(retained.stage === "Tables"),
  };
};
const verify = (
  input: Readonly<{
    import: SqliteImportInput;
    checkpoint: ImportCheckpoint;
    node: SnapshotArtifact;
  }>
): ImportCheckpoint => {
  if (input.node.kind !== "schema") throw Error("Invalid verification chain");
  if (input.node.object.type === "table") {
    const name = input.node.object.name.replaceAll('"', '""');
    const cursor = input.import.state.storage.sql.exec(`PRAGMA foreign_key_check("${name}")`);
    if (cursor.next().done !== true) throw Error("Imported foreign-key violation");
  }
  return { ...input.checkpoint, head: input.node.previous };
};
const finish = (input: ImportCheckpoint): ImportCheckpoint => {
  if (
    input.copiedRows !== input.manifest.rows ||
    input.schemaObjects !== input.manifest.schemaObjects
  ) {
    throw Error("Incomplete import");
  }
  return { ...input, phase: "ErasureVerification", stage: "Complete" };
};
const step = (
  input: Readonly<{ import: SqliteImportInput; checkpoint: ImportCheckpoint }>
): Effect.Effect<ImportCheckpoint, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const { checkpoint: retained } = input;
    const node = yield* Option.match(retained.head, {
      onNone: () => Effect.succeed(Option.none<SnapshotArtifact>()),
      onSome: (digest) => input.import.readArtifact(digest).pipe(Effect.asSome),
    });
    assertCheckpoint(input);
    foreignKeys({ storage: input.import.state.storage, enabled: retained.stage === "ForeignKeys" });
    return input.import.state.storage.transactionSync(() => {
      assertCheckpoint(input);
      const next = Option.match(node, {
        onNone: () => (retained.stage === "ForeignKeys" ? finish(retained) : nextStage(input)),
        onSome: (node) =>
          retained.stage === "ForeignKeys" ? verify({ ...input, node }) : apply({ ...input, node }),
      });
      save({ ...input, checkpoint: next });
      return next;
    });
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
export const advanceImport = (
  input: SqliteImportInput
): Effect.Effect<SqliteImportStatus, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const previous = currentCheckpoint(input);
    const retained = yield* Option.match(previous, {
      onNone: () => initialize(input),
      onSome: Effect.succeed,
    });
    const next =
      retained.phase === "ErasureVerification"
        ? retained
        : yield* step({ import: input, checkpoint: retained });
    return {
      phase: next.phase,
      stage: next.stage,
      copiedRows: next.copiedRows,
      schemaObjects: next.schemaObjects,
    };
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
