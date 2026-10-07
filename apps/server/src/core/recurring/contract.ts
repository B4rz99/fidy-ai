import { BigDecimal, Schema } from "effect";
import { Money, type ReadonlyMoney } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  Counterparty,
  type RecurringTransactionFact,
  TransactionId,
} from "~/core/transactions/contract";

/** Assigned once; confirmation replay and later observations retain this identity. */
export const RecurringSeriesId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecurringSeriesId")
);
export type RecurringSeriesId = typeof RecurringSeriesId.Type;
/** Identity of one immutable detector-independent confirmation occurrence. */
export const RecurringConfirmationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("RecurringConfirmationId")
);
export type RecurringConfirmationId = typeof RecurringConfirmationId.Type;
/** Monthly means consecutive calendar months in the captured evaluation zone, not thirty days. */
export const Cadence = Schema.Struct({ kind: Schema.Literal("monthly") });
/** Eligibility fixed at first confirmation; suppression never expires into a delayed announcement. */
export const Announcement = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("eligible") }),
  Schema.Struct({
    kind: Schema.Literal("suppressed"),
    reason: Schema.Literals(["backfill", "cold-start"]),
  }),
]);
export type Announcement = typeof Announcement.Type;
const positiveMoney = Money.check(
  Schema.makeFilter(
    (money: ReadonlyMoney) => BigDecimal.Order(money.amount, BigDecimal.make(0n, 0)) > 0
  )
);
/** A detected historical pattern, not proof that a charge is still active or will happen again. */
export const RecurringSeries = Schema.Struct({
  id: RecurringSeriesId,
  counterparty: Counterparty,
  money: positiveMoney,
  cadence: Cadence,
  firstOccurredAt: UtcTimestamp,
  lastOccurredAt: UtcTimestamp,
  confirmedAt: UtcTimestamp,
  announcement: Announcement,
}).annotate({ identifier: "RecurringSeries" });
export type RecurringSeries = typeof RecurringSeries.Type;
/** Immutable confirmation snapshot; no algorithm scores or private clustering evidence escape. */
export const RecurringSeriesConfirmed = Schema.Struct({
  id: RecurringConfirmationId,
  seriesId: RecurringSeriesId,
  counterparty: Counterparty,
  confirmedAt: UtcTimestamp,
  money: positiveMoney,
  cadence: Cadence,
  announcement: Announcement,
}).annotate({ identifier: "RecurringSeriesConfirmed" });
export type RecurringSeriesConfirmed = typeof RecurringSeriesConfirmed.Type;
/** Minimal facts are declared once by Transactions; capture classification is never guessed by the detector. */
export type RecurringFact = RecurringTransactionFact;
/** A pure proposal with unique support; the native owner assigns identity and eligibility. */
export const RecurringProposal = Schema.Struct({
  counterparty: Counterparty,
  money: positiveMoney,
  referenceMoney: positiveMoney,
  firstOccurredAt: UtcTimestamp,
  lastOccurredAt: UtcTimestamp,
  supportingTransactionIds: Schema.Tuple([TransactionId, TransactionId, TransactionId]).check(
    Schema.makeFilter((ids: ReadonlyArray<TransactionId>) => new Set(ids).size === ids.length)
  ),
  latestTransactionId: TransactionId,
  backfill: Schema.Boolean,
});
/** Immutable decision view derived from the canonical proposal; BigDecimal caches are not caller authority. */
export type RecurringProposal = Omit<typeof RecurringProposal.Type, "money" | "referenceMoney"> &
  Readonly<{ money: ReadonlyMoney; referenceMoney: ReadonlyMoney }>;
/** Whether the latest complete evaluation still describes the current financial facts. */
export const EvaluationStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-evaluated") }),
  Schema.Struct({ kind: Schema.Literal("updating") }),
  Schema.Struct({ kind: Schema.Literal("current"), asOf: UtcTimestamp }),
]);
const maximumCursorLength = 1024;
/** A bounded page of historical patterns; an updating result must not be called complete. */
export const RecurringSeriesPage = Schema.Struct({
  series: Schema.Array(RecurringSeries),
  evaluation: EvaluationStatus,
  cursor: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumCursorLength))
  ),
}).annotate({ identifier: "RecurringSeriesPage" });
