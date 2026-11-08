import { type Option, Schema } from "effect";

export const ProtectedCommand = Schema.Struct({
  sql: Schema.String,
  params: Schema.Array(
    Schema.Union([Schema.Null, Schema.String, Schema.Finite, Schema.Array(Schema.Finite)])
  ),
});
export type ProtectedCommand = typeof ProtectedCommand.Type;
const maximumCommands = 256;
export const ProtectedUnit = Schema.Struct({
  commands: Schema.Array(ProtectedCommand).check(Schema.isMaxLength(maximumCommands)),
  bookmark: Schema.OptionFromOptionalKey(Schema.String),
});
export type ProtectedUnit = typeof ProtectedUnit.Type;

export type ProtectedExecution = (unit: ProtectedUnit) => Promise<
  Readonly<{
    rows: D1Result[];
    bookmark: Option.Option<D1SessionBookmark>;
  }>
>;

export const maximumErrorLength = 2048;
const duration = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const RecoveryTiming = Schema.Struct({
  r2: duration,
  d1: duration,
  generations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  batches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sql: Schema.OptionFromNullOr(duration),
});
export type RecoveryTiming = typeof RecoveryTiming.Type;
const NativeResult = Schema.Struct({
  success: Schema.Literal(true),
  results: Schema.mutable(Schema.Array(Schema.Unknown)),
  meta: Schema.StructWithRest(
    Schema.Struct({
      duration,
      size_after: duration,
      rows_read: duration,
      rows_written: duration,
      last_row_id: Schema.Finite,
      changed_db: Schema.Boolean,
      changes: duration,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
});
export const ProtectedReply = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("completed"),
    rows: Schema.mutable(Schema.Array(NativeResult)),
    bookmark: Schema.OptionFromNullOr(Schema.String),
    timing: RecoveryTiming,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    unavailable: Schema.Boolean,
    errors: Schema.Array(Schema.String.check(Schema.isMaxLength(maximumErrorLength))).check(
      Schema.isMaxLength(4)
    ),
    timing: RecoveryTiming,
  }),
]);
export type ProtectedReply = typeof ProtectedReply.Type;

export const ProtectedStorageHealth = Schema.Struct({
  status: Schema.Literal("available"),
  protocol: Schema.Literal(1),
});
