import { Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { RecurringProposal } from "../../../src/core/recurring/contract";
import { TransactionId } from "../../../src/core/transactions/contract";

const progressFields = {
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  phase: Schema.Literals(["scan", "detect", "complete"]),
  group_key: Schema.String,
  evaluated_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  first_captured_at_ms: Schema.DateTimeUtcFromMillis,
  time_zone: IanaTimeZone,
};
export const Progress = Schema.Union([
  Schema.Struct({ ...progressFields, cursor_at_ms: Schema.Null, cursor_id: Schema.Literal("") }),
  Schema.Struct({
    ...progressFields,
    cursor_at_ms: Schema.DateTimeUtcFromMillis,
    cursor_id: TransactionId,
  }),
]);
export type Progress = typeof Progress.Type;
export const Proposal = RecurringProposal;
export const Evidence = Schema.Struct({
  supportingTransactionIds: RecurringProposal.fields.supportingTransactionIds,
  latestTransactionId: TransactionId,
  detectorRevision: Schema.Literal("monthly-v1"),
  evaluatedFactRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const StoredSeries = Schema.Struct({
  series_json: Schema.String,
  evidence_json: Schema.String,
  reference_json: Schema.String,
});
export const StringRow = Schema.Struct({ value: Schema.String });
export const maximumGroupFacts = 512;
export const maximumSeries = 128;
export const pageSize = 32;
