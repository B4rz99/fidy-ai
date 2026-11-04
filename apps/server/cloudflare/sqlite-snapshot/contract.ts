import { Data, type Option, Schema } from "effect";
import {
  type RecoveryClosedSourceAccess,
  RecoveryClosedSourceEvidence,
  type RecoverySourceTarget,
  RecoveryTarget,
} from "../recovery-activation/contract";

export const snapshotPageBytes = 16777216;
const maximumIdentifierLength = 256;
const maximumColumns = 99;
const Identifier = Schema.String.check(Schema.isBetweenLength(1, maximumIdentifierLength));
const minimumInteger = -9223372036854775808n;
const maximumInteger = 9223372036854775807n;
export const SnapshotInteger = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^(?:0|[1-9]\d{0,18}|-[1-9]\d{0,18})$/u.test(value) &&
      BigInt(value) >= minimumInteger &&
      BigInt(value) <= maximumInteger
  )
);
export const SnapshotCell = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("null") }),
  Schema.Struct({ kind: Schema.Literal("integer"), value: SnapshotInteger }),
  Schema.Struct({ kind: Schema.Literal("real"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("blob"),
    value: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})*$/u)),
  }),
]);
export type SnapshotCell = typeof SnapshotCell.Type;
export const SnapshotTable = Schema.Struct({
  name: Identifier,
  sql: Schema.String,
  columns: Schema.UniqueArray(Identifier).check(Schema.isBetweenLength(1, maximumColumns)),
});
export type SnapshotTable = typeof SnapshotTable.Type;
export const SnapshotTablePage = Schema.Struct({
  version: Schema.Literal(1),
  evidence: RecoveryClosedSourceEvidence,
  target: RecoveryTarget,
  afterRowid: Schema.OptionFromNullOr(SnapshotInteger),
  table: SnapshotTable,
  row: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("end") }),
    Schema.Struct({
      kind: Schema.Literal("row"),
      rowid: SnapshotInteger,
      cells: Schema.Array(SnapshotCell).check(Schema.isMaxLength(maximumColumns)),
    }),
  ]),
});
export type SnapshotTablePage = typeof SnapshotTablePage.Type;
/** Fixed private operator capabilities only. The recovery owner grants export access after actual source closure. */
export type ClosedSnapshotExport = Readonly<{
  db: D1Database;
  /** Dedicated private temporary data artifacts; never the independent Erasure metadata registry. */
  artifacts: R2Bucket;
  source: RecoverySourceTarget;
  target: RecoveryTarget;
  activationId: string;
  closedSource: RecoveryClosedSourceAccess;
  table: string;
  afterRowid: Option.Option<string>;
}>;
export type SnapshotPageReceipt = Readonly<{
  key: string;
  digest: string;
  rowid: Option.Option<string>;
}>;
export class SnapshotUnavailable extends Data.TaggedError("SnapshotUnavailable") {}
