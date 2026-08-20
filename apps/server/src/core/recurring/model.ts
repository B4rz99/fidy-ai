import { BigDecimal, Schema } from "effect";
import { type Immutable } from "~/core/_shared/immutable";
import { Currency, Money, MoneyGroup, MoneyGroups } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { Counterparty, Direction, TransactionId } from "~/core/transactions/reference";
import { RecurringCadence, RecurringSeriesId } from "./reference";

export { RecurringCadence, RecurringSeriesId } from "./reference";

const zero = BigDecimal.make(0n, 0);
const minimumConfirmedOccurrences = 3;

/**
 * Why a confirmed series is held back from proactive announcement. `backfill` means every
 * occurrence predates fidy's observation of the User, so the series was learned from imported
 * history rather than watched as it happened; `cold-start` means the User's history is still
 * too young for a repeating charge to be worth announcing as news.
 */
export const RecurringSuppressionReason = Schema.Literals(["backfill", "cold-start"]).annotate({
  identifier: "RecurringSuppressionReason",
});
export type RecurringSuppressionReason = typeof RecurringSuppressionReason.Type;

/**
 * Whether this series may raise the `new recurring series confirmed` trigger. A suppressed
 * series is a real, listable RecurringSeries — suppression withholds the announcement, never
 * the series itself — so the reason is present exactly when the state is `suppressed`.
 */
export const RecurringAnnouncement = Schema.Union([
  Schema.Struct({ state: Schema.Literal("announceable") }),
  Schema.Struct({
    state: Schema.Literal("suppressed"),
    reason: RecurringSuppressionReason,
  }),
]).annotate({
  identifier: "RecurringAnnouncement",
  description:
    "Whether fidy may raise this series as news. A suppressed series is still a real recurring " +
    "charge worth answering questions about; only the unprompted announcement is withheld.",
});
export type RecurringAnnouncement = typeof RecurringAnnouncement.Type;

const RecurringSeriesFacts = Schema.Struct({
  counterparty: Counterparty.annotate({
    description:
      "The person or organization the charge repeats with. A series is only formed where the " +
      "captured Transactions explicitly identified one, so this is never inferred.",
  }),
  direction: Direction,
  cadence: RecurringCadence,
  typicalMoney: Money.annotate({
    description:
      "What one occurrence currently costs, taken from the most recent occurrence rather than " +
      "averaged. Every occurrence in the series shares this Currency.",
  }),
  occurrences: Schema.UniqueArray(TransactionId)
    .check(Schema.isMinLength(minimumConfirmedOccurrences))
    .annotate({
      description:
        "The Transactions that confirmed this series, oldest first. At least three, because two " +
        "movements are one interval and one interval is not yet a rhythm.",
    }),
  firstOccurredAt: UtcTimestamp,
  lastOccurredAt: UtcTimestamp,
  announcement: RecurringAnnouncement,
});

type RecurringSeriesView = Immutable<typeof RecurringSeriesFacts.Type>;

const positiveTypicalMoney = Schema.makeFilter<RecurringSeriesView>((series) =>
  BigDecimal.Order(series.typicalMoney.amount, zero) === 1
    ? undefined
    : { path: ["typicalMoney", "amount"], issue: "A RecurringSeries occurrence must move Money" }
);

const orderedOccurrenceWindow = Schema.makeFilter<RecurringSeriesView>((series) =>
  series.firstOccurredAt.epochMilliseconds <= series.lastOccurredAt.epochMilliseconds
    ? undefined
    : { path: ["lastOccurredAt"], issue: "Expected the last occurrence at or after the first" }
);

/**
 * One repeating charge a detector has confirmed but that has not yet been recorded: the same
 * Counterparty, direction, and Currency at a steady cadence. Identity and the instant of
 * confirmation belong to whoever records it.
 */
export const DetectedRecurringSeries = RecurringSeriesFacts.check(
  positiveTypicalMoney,
  orderedOccurrenceWindow
).annotate({ identifier: "DetectedRecurringSeries" });
export type DetectedRecurringSeries = typeof DetectedRecurringSeries.Type;

/**
 * A recorded RecurringSeries owned by one User. Re-running detection re-confirms an existing
 * series rather than creating a second one, so `id` survives and `detectedAt` names the first
 * confirmation rather than the most recent scan.
 */
export const RecurringSeries = Schema.Struct({
  id: RecurringSeriesId,
  ...RecurringSeriesFacts.fields,
  detectedAt: UtcTimestamp,
})
  .check(positiveTypicalMoney, orderedOccurrenceWindow)
  .annotate({ identifier: "RecurringSeries" });
export type RecurringSeries = typeof RecurringSeries.Type;

/**
 * What one detection pass concluded: the series it confirmed for the first time, and the
 * Currency-grouped Money standing behind the `new recurring series confirmed` trigger.
 *
 * `announcement` is deliberately the same shape an InsightEvent carries, and deliberately not
 * derived from `confirmed` by the reader: suppressed series appear in `confirmed` and are absent
 * from `announcement`. It carries no cadence evidence, tolerance, or detector identity, so the
 * detector behind it can be replaced without changing what a consumer reads.
 */
export const RecurringDetectionOutcome = Schema.Struct({
  confirmed: Schema.Array(RecurringSeries),
  announcement: MoneyGroups,
}).annotate({ identifier: "RecurringDetectionOutcome" });
export type RecurringDetectionOutcome = typeof RecurringDetectionOutcome.Type;

const groupCurrencyMatches = Schema.makeFilter<
  Immutable<{
    currency: Currency;
    series: ReadonlyArray<RecurringSeries>;
    perOccurrence: MoneyGroup;
  }>
>((group) => {
  if (group.perOccurrence.currency !== group.currency) {
    return { path: ["perOccurrence", "currency"], issue: "Expected the group Currency" };
  }
  const foreign = group.series.findIndex(
    (series) => series.typicalMoney.currency !== group.currency
  );
  return foreign === -1
    ? undefined
    : {
        path: ["series", foreign, "typicalMoney", "currency"],
        issue: "Expected the group Currency",
      };
});

/**
 * Every RecurringSeries sharing one Currency, with the direction-separated cost of one round of
 * them. The total is per occurrence and not per month: cadences differ inside a group, and
 * normalizing them to a common period would invent a figure the User never pays.
 */
export const RecurringCurrencyGroup = Schema.Struct({
  currency: Currency,
  series: Schema.NonEmptyArray(RecurringSeries),
  perOccurrence: MoneyGroup,
})
  .check(groupCurrencyMatches)
  .annotate({
    identifier: "RecurringCurrencyGroup",
    description:
      "One Currency's recurring commitments and what one occurrence of each adds up to. Totals " +
      "never cross Currencies and fidy performs no conversion.",
  });
export type RecurringCurrencyGroup = typeof RecurringCurrencyGroup.Type;

const deterministicGroupOrder = Schema.makeFilter<ReadonlyArray<Readonly<{ currency: Currency }>>>(
  (groups) => {
    for (const [index, current] of groups.entries()) {
      const previous = groups[index - 1];
      if (previous !== undefined && previous.currency >= current.currency) {
        return {
          path: [index, "currency"],
          issue: "Expected unique Currency groups in alphabetic order",
        };
      }
    }
    return undefined;
  }
);

/**
 * The answer to "what recurring charges do I have": every confirmed RecurringSeries the User
 * owns, split by explicit Currency in alphabetic order. An empty report is an answer rather
 * than an omission.
 */
export const RecurringSeriesReport = Schema.Struct({
  groups: Schema.Array(RecurringCurrencyGroup).check(deterministicGroupOrder),
}).annotate({ identifier: "RecurringSeriesReport" });
export type RecurringSeriesReport = typeof RecurringSeriesReport.Type;
