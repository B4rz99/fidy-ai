import * as Arr from "effect/Array";
import { BigDecimal, type DateTime, type Effect, Option, Order } from "effect";
import { type Immutable } from "~/core/_shared/immutable";
import {
  type Currency,
  Money,
  type ReadonlyMoney,
  type ReadonlyMoneyGroup,
  groupMoney,
} from "~/core/_shared/money";
import {
  type Counterparty,
  type Direction,
  type TransactionId,
} from "~/core/transactions/reference";
import {
  type DetectedRecurringSeries,
  type RecurringAnnouncement,
  type RecurringCadence,
} from "./model";

const millisecondsPerDay = 86_400_000;
const minimumConfirmedOccurrences = 3;
const coldStartDays = 30;

// The spread the cheapest and dearest occurrence may span, as a fraction of the cheapest. Real
// repeating charges drift — a plan changes, a tax is applied, a usage tier moves — so demanding
// exact equality would miss most of them. The comparison stays exact BigDecimal arithmetic inside
// one Currency; this fraction never becomes a float and is never applied across denominations.
const amountTolerance = BigDecimal.make(15n, 2);

type CadenceBand = Readonly<{
  cadence: RecurringCadence;
  minimumDays: number;
  maximumDays: number;
}>;

// The day spans each named cadence accepts, loosest where the calendar itself is: a monthly
// charge on the 31st lands 28 to 31 days later, and a yearly one crosses a leap day. The bands
// do not overlap, so at most one cadence can claim a given set of gaps. These spans are detector
// internals — the published RecurringCadence carries the name alone.
const cadenceBands: ReadonlyArray<CadenceBand> = [
  { cadence: "weekly", minimumDays: 6, maximumDays: 8 },
  { cadence: "fortnightly", minimumDays: 12, maximumDays: 16 },
  { cadence: "monthly", minimumDays: 27, maximumDays: 33 },
  { cadence: "quarterly", minimumDays: 84, maximumDays: 98 },
  { cadence: "yearly", minimumDays: 350, maximumDays: 380 },
];

/** The Transaction facts one detection pass reads; the shell projects stored history into it. */
export type RecurringCandidate = Immutable<{
  id: TransactionId;
  money: ReadonlyMoney;
  counterparty: Option.Option<Counterparty>;
  direction: Direction;
  occurredAt: DateTime.Utc;
}>;

/**
 * One detection pass over a User's history. `observedSince` is the instant fidy began watching
 * this User: occurrences before it were learned from imported history rather than seen as they
 * happened. `now` decides whether the User is still inside the cold-start window, so both
 * instants are supplied by the caller and never read from the clock here.
 */
export type RecurringObservation = Immutable<{
  transactions: ReadonlyArray<RecurringCandidate>;
  now: DateTime.Utc;
  observedSince: DateTime.Utc;
}>;

type CandidateGroup = Readonly<{
  counterparty: Counterparty;
  direction: Direction;
  currency: Currency;
  members: Arr.NonEmptyReadonlyArray<RecurringCandidate>;
}>;

const byOccurredAt: Order.Order<RecurringCandidate> = Order.mapInput(
  Order.Number,
  (candidate: RecurringCandidate) => candidate.occurredAt.epochMilliseconds
);

const byCounterpartyCurrencyDirection: Order.Order<DetectedRecurringSeries> = Order.combine(
  Order.mapInput(Order.String, (series: DetectedRecurringSeries) => series.counterparty),
  Order.combine(
    Order.mapInput(Order.String, (series: DetectedRecurringSeries) => series.typicalMoney.currency),
    Order.mapInput(Order.String, (series: DetectedRecurringSeries) => series.direction)
  )
);

// Currency is part of the key, not a property of the group's members: two denominations are two
// groups, so nothing downstream can compare or add across them and no rate is ever needed.
// Counterparty absence means it was never known at capture (CONTEXT.md), and inferring one from
// Category or amount would manufacture the fact the model refuses to guess — so such a
// Transaction joins no group rather than joining a nameless one.
const groupComparableCandidates = (
  transactions: ReadonlyArray<RecurringCandidate>
): ReadonlyArray<CandidateGroup> => {
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of transactions) {
    if (Option.isNone(candidate.counterparty)) continue;
    const counterparty = candidate.counterparty.value;
    const key = JSON.stringify([counterparty, candidate.direction, candidate.money.currency]);
    const current = groups.get(key);
    groups.set(key, {
      counterparty,
      direction: candidate.direction,
      currency: candidate.money.currency,
      members: current === undefined ? Arr.of(candidate) : Arr.append(current.members, candidate),
    });
  }
  return [...groups.values()];
};

const wholeDaysBetween = (earlier: DateTime.Utc, later: DateTime.Utc): number =>
  Math.round((later.epochMilliseconds - earlier.epochMilliseconds) / millisecondsPerDay);

// Consecutive gaps in whole days. Charges land at different times of day, so the rhythm is
// counted in days rather than instants and a few hours of drift never breaks a cadence.
const consecutiveDayGaps = (
  members: Arr.NonEmptyReadonlyArray<RecurringCandidate>
): ReadonlyArray<number> => {
  const gaps: Array<number> = [];
  for (const [index, member] of members.entries()) {
    const previous = members[index - 1];
    if (previous === undefined) continue;
    gaps.push(wholeDaysBetween(previous.occurredAt, member.occurredAt));
  }
  return gaps;
};

const matchedCadence = (gaps: ReadonlyArray<number>): Option.Option<RecurringCadence> =>
  Option.map(
    Option.fromNullishOr(
      cadenceBands.find((band) =>
        gaps.every((gap) => gap >= band.minimumDays && gap <= band.maximumDays)
      )
    ),
    (band) => band.cadence
  );

// Judged across the whole series rather than against a running average: the dearest occurrence
// may exceed the cheapest by the tolerated fraction of the cheapest, so no single outlier can
// drag a representative value along behind it and quietly admit the rest.
const comparableAmounts = (members: Arr.NonEmptyReadonlyArray<RecurringCandidate>): boolean => {
  const amounts = Arr.map(members, (member) => member.money.amount);
  const cheapest = amounts.reduce((left, right) => BigDecimal.min(left, right));
  const dearest = amounts.reduce((left, right) => BigDecimal.max(left, right));
  return (
    BigDecimal.Order(
      BigDecimal.subtract(dearest, cheapest),
      BigDecimal.multiply(cheapest, amountTolerance)
    ) <= 0
  );
};

const decideAnnouncement = (
  members: Arr.NonEmptyReadonlyArray<RecurringCandidate>,
  observation: RecurringObservation
): RecurringAnnouncement => {
  if (wholeDaysBetween(observation.observedSince, observation.now) < coldStartDays) {
    return { state: "suppressed", reason: "cold-start" };
  }
  return members.every(
    (member) => member.occurredAt.epochMilliseconds < observation.observedSince.epochMilliseconds
  )
    ? { state: "suppressed", reason: "backfill" }
    : { state: "announceable" };
};

const confirmSeries = (
  group: CandidateGroup,
  observation: RecurringObservation
): Option.Option<DetectedRecurringSeries> => {
  const ordered = Arr.sort(group.members, byOccurredAt);
  if (ordered.length < minimumConfirmedOccurrences) return Option.none();
  if (!comparableAmounts(ordered)) return Option.none();

  const cadence = matchedCadence(consecutiveDayGaps(ordered));
  if (Option.isNone(cadence)) return Option.none();

  const latest = Arr.lastNonEmpty(ordered);
  return Option.some({
    counterparty: group.counterparty,
    direction: group.direction,
    cadence: cadence.value,
    typicalMoney: Money.make(latest.money),
    occurrences: Arr.map(ordered, (member) => member.id),
    firstOccurredAt: Arr.headNonEmpty(ordered).occurredAt,
    lastOccurredAt: latest.occurredAt,
    announcement: decideAnnouncement(ordered, observation),
  } satisfies DetectedRecurringSeries);
};

/**
 * Confirms every repeating charge in one User's history. A series needs at least three
 * Transactions sharing a Counterparty, a direction, and one Currency, whose amounts stay inside
 * the tolerated spread and whose consecutive gaps all fall within one named cadence. Three,
 * because two movements are a single interval and a single interval is not yet a rhythm.
 *
 * Comparison never crosses Currencies: each denomination is its own group, so a Counterparty
 * billing in COP and in USD yields two independent series or none, and no rate is ever applied.
 * A Transaction whose Counterparty was not captured joins nothing. The result is ordered by
 * Counterparty, then Currency, then direction, so one history always confirms the same series in
 * the same order.
 */
export const detectRecurringSeries = (
  observation: RecurringObservation
): ReadonlyArray<DetectedRecurringSeries> =>
  Arr.sort(
    groupComparableCandidates(observation.transactions).flatMap((group) =>
      Option.toArray(confirmSeries(group, observation))
    ),
    byCounterpartyCurrencyDirection
  );

/**
 * Summarizes confirmed series into the Currency-grouped Money carried by the `new recurring
 * series confirmed` trigger. Suppressed series are withheld, and what survives is domain fact
 * only — no cadence evidence, tolerance, threshold, or detector identity — so replacing the
 * detector cannot change the shape of the announcement. Empty means nothing is worth announcing.
 */
export const summarizeConfirmedSeries = (
  series: ReadonlyArray<Immutable<DetectedRecurringSeries>>
): Effect.Effect<ReadonlyArray<ReadonlyMoneyGroup>> => {
  const announceable = series.filter(
    (candidate) => candidate.announcement.state === "announceable"
  );
  return groupMoney({
    inflows: announceable
      .filter((candidate) => candidate.direction === "inflow")
      .map((candidate) => candidate.typicalMoney),
    outflows: announceable
      .filter((candidate) => candidate.direction === "outflow")
      .map((candidate) => candidate.typicalMoney),
  });
};
