import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { digestBytes } from "../../secret-material/operations";
import { prepareClosedSourceGenerationFence } from "../../erasure/operations";
import {
  RecoveryClosedSourceEvidence,
  RecoverySourceTarget,
} from "../../recovery-activation/contract";
import {
  type ClosedSnapshotExport,
  type ClosedSnapshotSource,
  SnapshotCell,
  SnapshotInteger,
  type SnapshotPageReceipt,
  SnapshotTable,
  SnapshotTablePage,
  SnapshotUnavailable,
  snapshotPageBytes,
} from "../contract";

const io = <A>(work: () => Promise<A>): Effect.Effect<A, SnapshotUnavailable> =>
  Effect.tryPromise({ try: work, catch: () => new SnapshotUnavailable() });
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const Catalog = Schema.Tuple([Schema.Struct({ name: Schema.String, sql: Schema.String })]);
const Column = Schema.Struct({ name: Schema.String, hidden: Schema.Int });
const encodeSource = Schema.encodeSync(Schema.fromJsonString(RecoverySourceTarget));
export const evidence = (
  input: ClosedSnapshotSource
): Effect.Effect<RecoveryClosedSourceEvidence, SnapshotUnavailable> =>
  input.closedSource({ activationId: input.activationId, source: input.source }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RecoveryClosedSourceEvidence)),
    Effect.filterOrFail(
      (value) =>
        value.activationId === input.activationId &&
        encodeSource(value.source) === encodeSource(input.source),
      () => new SnapshotUnavailable()
    ),
    Effect.mapError(() => new SnapshotUnavailable())
  );
export const readRows = ({
  input,
  proof,
  statement,
}: Readonly<{
  input: ClosedSnapshotSource;
  proof: RecoveryClosedSourceEvidence;
  statement: D1PreparedStatement;
}>): Effect.Effect<ReadonlyArray<Record<string, unknown>>, SnapshotUnavailable> =>
  io(() =>
    input.db.batch([
      prepareClosedSourceGenerationFence({ db: input.db, generation: proof.sourceGeneration }),
      statement,
    ])
  ).pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Rows)(rows[1]?.results)),
    Effect.mapError(() => new SnapshotUnavailable())
  );
export const table = ({
  input,
  proof,
}: Readonly<{ input: ClosedSnapshotExport; proof: RecoveryClosedSourceEvidence }>): Effect.Effect<
  SnapshotTable,
  SnapshotUnavailable
> =>
  Effect.gen(function* () {
    const rows = yield* readRows({
      input,
      proof,
      statement: input.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=? AND name NOT GLOB '__cf_*' AND name NOT GLOB '_cf_*' AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence')"
        )
        .bind(input.table),
    });
    const [catalog] = yield* Schema.decodeUnknownEffect(Catalog)(rows);
    if (/WITHOUT\s+ROWID|CREATE\s+VIRTUAL/iu.test(catalog.sql)) {
      return yield* new SnapshotUnavailable();
    }
    const columns = yield* Schema.decodeUnknownEffect(Schema.Array(Column))(
      yield* readRows({
        input,
        proof,
        statement: input.db
          .prepare("SELECT name,hidden FROM pragma_table_xinfo(?) ORDER BY cid")
          .bind(catalog.name),
      })
    );
    return yield* Schema.decodeEffect(SnapshotTable)({
      ...catalog,
      columns: columns.filter((column) => column.hidden === 0).map((column) => column.name),
    });
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const nativeCell = (row: Readonly<Record<string, unknown>>, index: number): SnapshotCell => {
  const kind = Schema.decodeUnknownSync(
    Schema.Literals(["integer", "real", "text", "blob", "null"])
  )(row[`k${index}`]);
  if (kind === "null") return { kind };
  const value = row[`v${index}`];
  if (kind === "blob") {
    return {
      kind,
      value: Hex.encode(
        new Uint8Array(
          Schema.decodeUnknownSync(
            Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
          )(value)
        )
      ),
    };
  }
  return Schema.decodeUnknownSync(SnapshotCell)({ kind, value });
};
const projection = (name: string, index: number): string => {
  const column = quote(name);
  return `typeof(${column}) AS k${index}, CASE typeof(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN printf('%!.17g',${column}) ELSE ${column} END AS v${index}`;
};
export const row = ({
  input,
  proof,
  retained,
}: Readonly<{
  input: ClosedSnapshotExport;
  proof: RecoveryClosedSourceEvidence;
  retained: SnapshotTable;
}>): Effect.Effect<SnapshotTablePage["row"], SnapshotUnavailable> =>
  Effect.gen(function* () {
    const after = yield* Option.match(input.afterRowid, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) => Schema.decodeEffect(SnapshotInteger)(value).pipe(Effect.asSome),
    });
    const sql = `SELECT CAST(_rowid_ AS TEXT) AS position, ${retained.columns.map(projection).join(",")} FROM ${quote(retained.name)} ${Option.isSome(after) ? "WHERE _rowid_ > CAST(? AS INTEGER)" : ""} ORDER BY _rowid_ LIMIT 1`;
    const selected = yield* readRows({
      input,
      proof,
      statement: input.db.prepare(sql).bind(...Option.toArray(after)),
    });
    const first = selected[0];
    if (first === undefined) return { kind: "end" } as const;
    return {
      kind: "row" as const,
      rowid: yield* Schema.decodeUnknownEffect(Schema.String)(first.position),
      cells: retained.columns.map((_, index) => nativeCell(first, index)),
    };
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const retain = (
  input: ClosedSnapshotExport,
  page: SnapshotTablePage
): Effect.Effect<SnapshotPageReceipt, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotTablePage))(page);
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.byteLength > snapshotPageBytes) return yield* new SnapshotUnavailable();
    const digest = Hex.encode(yield* digestBytes(bytes));
    const key = `recovery/sqlite-snapshots/pages/${digest}`;
    const latest = yield* evidence(input);
    const expected = yield* Schema.encodeEffect(
      Schema.fromJsonString(RecoveryClosedSourceEvidence)
    )(page.evidence);
    const observed = yield* Schema.encodeEffect(
      Schema.fromJsonString(RecoveryClosedSourceEvidence)
    )(latest);
    if (observed !== expected) return yield* new SnapshotUnavailable();
    const stored = yield* io(() =>
      input.artifacts.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } })
    );
    if (stored === null) {
      const previous = yield* io(() => input.artifacts.get(key));
      if (previous === null || previous.size !== bytes.byteLength) {
        return yield* new SnapshotUnavailable();
      }
      const hash = Hex.encode(
        yield* digestBytes(new Uint8Array(yield* io(() => previous.arrayBuffer())))
      );
      if (hash !== digest) return yield* new SnapshotUnavailable();
    }
    return {
      key,
      digest,
      rowid: page.row.kind === "row" ? Option.some(page.row.rowid) : Option.none(),
    };
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));

export const exportTable = (
  input: ClosedSnapshotExport
): Effect.Effect<SnapshotPageReceipt, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const proof = yield* evidence(input);
    const retained = yield* table({ input, proof });
    const selected = yield* row({ input, proof, retained });
    return yield* retain(input, {
      version: 1,
      evidence: proof,
      target: input.target,
      afterRowid: input.afterRowid,
      table: retained,
      row: selected,
    });
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
