import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { digestBytes } from "../../secret-material/operations";
import { RecoveryClosedSourceEvidence, RecoveryTarget } from "../../recovery-activation/contract";
import {
  type ClosedSnapshotSource,
  SnapshotBuildState,
  type SnapshotBuildStatus,
  SnapshotSchemaObject,
  SnapshotUnavailable,
} from "../contract";
import { evidence, readRows, row, table } from "./export";
import { artifactIo, artifactPut } from "./artifact";

const maximumProgressBytes = 1048576;
type Previous = Option.Option<Readonly<{ state: SnapshotBuildState; etag: string }>>;
const jobKey = (input: ClosedSnapshotSource): Effect.Effect<string, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const target = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(input.target);
    const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(target)));
    return `recovery/sqlite-snapshots/jobs/${input.activationId}/${digest}`;
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const load = (
  input: ClosedSnapshotSource,
  key: string
): Effect.Effect<Previous, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const object = yield* artifactIo(() => input.artifacts.get(key));
    if (object === null) return Option.none();
    if (object.size > maximumProgressBytes) {
      yield* artifactIo(() => object.body.cancel());
      return yield* new SnapshotUnavailable();
    }
    const state = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotBuildState))(
      yield* artifactIo(() => object.text())
    );
    return Option.some({ state, etag: object.etag });
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const stable = (
  input: ClosedSnapshotSource,
  state: SnapshotBuildState
): Effect.Effect<void, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const latest = yield* evidence(input);
    const expected = yield* Schema.encodeEffect(
      Schema.fromJsonString(RecoveryClosedSourceEvidence)
    )(state.evidence);
    const actual = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryClosedSourceEvidence))(
      latest
    );
    const oldTarget = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(
      state.target
    );
    const target = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(input.target);
    if (expected !== actual || oldTarget !== target) return yield* new SnapshotUnavailable();
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const catalog = (
  input: ClosedSnapshotSource,
  state: Extract<SnapshotBuildState, { phase: "Catalog" }>
): Effect.Effect<SnapshotBuildState, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const selected = yield* readRows({
      input,
      proof: state.evidence,
      statement: input.db
        .prepare(
          `SELECT CAST(rowid AS TEXT) AS position,type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB '__cf_*' AND name NOT GLOB '_cf_*' AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence') ${Option.isSome(state.schemaCursor) ? "AND rowid > CAST(? AS INTEGER)" : ""} ORDER BY rowid LIMIT 1`
        )
        .bind(...Option.toArray(state.schemaCursor)),
    });
    const first = selected[0];
    if (first === undefined) {
      yield* stable(input, state);
      const artifactDigest = yield* artifactPut({
        ...input,
        artifact: { kind: "manifest", version: 1, ...state },
      });
      return { ...state, phase: "Ready" as const, artifactDigest };
    }
    const object = yield* Schema.decodeUnknownEffect(SnapshotSchemaObject)(first);
    yield* stable(input, state);
    const schemaHead = Option.some(
      yield* artifactPut({
        ...input,
        artifact: { kind: "schema", previous: state.schemaHead, object },
      })
    );
    const next = { ...state, schemaHead, schemaObjects: state.schemaObjects + 1 };
    if (object.type !== "table") return { ...next, schemaCursor: Option.some(object.position) };
    const retained = yield* table({
      input: { ...input, table: object.name, afterRowid: Option.none() },
      proof: state.evidence,
    });
    return {
      ...next,
      phase: "Rows" as const,
      schemaCursor: object.position,
      table: retained,
      afterRowid: Option.none(),
    };
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const data = (
  input: ClosedSnapshotSource,
  state: Extract<SnapshotBuildState, { phase: "Rows" }>
): Effect.Effect<SnapshotBuildState, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const selected = yield* row({
      input: { ...input, table: state.table.name, afterRowid: state.afterRowid },
      proof: state.evidence,
      retained: state.table,
    });
    if (selected.kind === "end") {
      return { ...state, phase: "Catalog" as const, schemaCursor: Option.some(state.schemaCursor) };
    }
    yield* stable(input, state);
    const digest = yield* artifactPut({
      ...input,
      artifact: {
        kind: "data",
        previous: state.dataHead,
        table: state.table.name,
        rowid: selected.rowid,
        cells: selected.cells,
      },
    });
    return {
      ...state,
      dataHead: Option.some(digest),
      rows: state.rows + 1,
      afterRowid: Option.some(selected.rowid),
    };
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const save = (
  input: Readonly<{
    source: ClosedSnapshotSource;
    key: string;
    previous: Previous;
    state: SnapshotBuildState;
  }>
): Effect.Effect<void, SnapshotUnavailable> =>
  Effect.gen(function* () {
    yield* stable(input.source, input.state);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotBuildState))(
      input.state
    );
    const result = yield* artifactIo(() =>
      input.source.artifacts.put(input.key, encoded, {
        onlyIf: Option.isSome(input.previous)
          ? { etagMatches: input.previous.value.etag }
          : { etagDoesNotMatch: "*" },
      })
    );
    if (result === null) return yield* new SnapshotUnavailable();
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const status = (state: SnapshotBuildState): SnapshotBuildStatus =>
  state.phase === "Ready"
    ? {
        kind: "Ready",
        artifactDigest: state.artifactDigest,
        schemaObjects: state.schemaObjects,
        rows: state.rows,
      }
    : { kind: "Continue", schemaObjects: state.schemaObjects, rows: state.rows };
export const advance = (
  input: ClosedSnapshotSource
): Effect.Effect<SnapshotBuildStatus, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const proof = yield* evidence(input);
    const key = yield* jobKey(input);
    const previous = yield* load(input, key);
    const state = Option.match(previous, {
      onSome: ({ state }) => state,
      onNone: (): SnapshotBuildState => ({
        phase: "Catalog",
        schemaCursor: Option.none(),
        schemaHead: Option.none(),
        dataHead: Option.none(),
        evidence: proof,
        target: input.target,
        schemaObjects: 0,
        rows: 0,
      }),
    });
    yield* stable(input, state);
    if (state.phase === "Ready") return status(state);
    const next = yield* state.phase === "Catalog" ? catalog(input, state) : data(input, state);
    yield* save({ source: input, key, previous, state: next });
    return status(next);
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
