import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Option } from "effect";
import { Currency, Money } from "~/core/_shared/money";
import { type Direction, TransactionId } from "~/core/transactions/reference";
import { type DetectedRecurringSeries } from "./model";
import {
  type RecurringCandidate,
  type RecurringObservation,
  detectRecurringSeries,
  summarizeConfirmedSeries,
} from "./rules";

const money = (amount: string, currency: Currency = Currency.make("COP")): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });

const transactionId = (index: number): TransactionId =>
  TransactionId.make(`f1d1a000-0000-4000-8000-${String(index).padStart(12, "0")}`);

type CandidateOverrides = Partial<{
  id: TransactionId;
  amount: string;
  currency: Currency;
  counterparty: Option.Option<string>;
  direction: Direction;
}>;

const candidateDefaults = {
  amount: "50000",
  currency: Currency.make("COP"),
  counterparty: Option.some("Claro"),
  direction: "outflow",
} as const;

let nextIndex = 0;
const occurrence = (occurredAt: string, overrides: CandidateOverrides = {}): RecurringCandidate => {
  const facts = { ...candidateDefaults, ...overrides };
  nextIndex += 1;
  return {
    id: Option.getOrElse(Option.fromUndefinedOr(overrides.id), () => transactionId(nextIndex)),
    money: money(facts.amount, facts.currency),
    counterparty: facts.counterparty,
    direction: facts.direction,
    occurredAt: DateTime.makeUnsafe(occurredAt),
  };
};

const observe = (
  transactions: ReadonlyArray<RecurringCandidate>,
  overrides: Partial<{ now: string; observedSince: string }> = {}
): RecurringObservation => ({
  transactions,
  now: DateTime.makeUnsafe(overrides.now ?? "2026-08-01T00:00:00Z"),
  observedSince: DateTime.makeUnsafe(overrides.observedSince ?? "2025-01-01T00:00:00Z"),
});

/** Three same-day-of-month occurrences, the shape a real subscription leaves behind. */
const monthlyClaro = (overrides: CandidateOverrides = {}): ReadonlyArray<RecurringCandidate> => [
  occurrence("2026-04-05T14:00:00Z", overrides),
  occurrence("2026-05-05T09:30:00Z", overrides),
  occurrence("2026-06-05T18:45:00Z", overrides),
];

const occurrenceWindow = (
  series: ReadonlyArray<DetectedRecurringSeries>
): ReadonlyArray<readonly [string, string]> =>
  series.map((entry) => [
    DateTime.formatIso(entry.firstOccurredAt),
    DateTime.formatIso(entry.lastOccurredAt),
  ]);

it("confirms a monthly series from realistic history with its cadence and nested Money", () => {
  const [series, ...rest] = detectRecurringSeries(observe(monthlyClaro()));

  expect(rest).toHaveLength(0);
  expect(series?.cadence).toBe("monthly");
  expect(series?.counterparty).toBe("Claro");
  expect(series?.direction).toBe("outflow");
  expect(series?.typicalMoney.currency).toBe("COP");
  expect(Equal.equals(series?.typicalMoney.amount, money("50000").amount)).toBe(true);
  expect(series?.occurrences).toHaveLength(3);
  expect(occurrenceWindow(detectRecurringSeries(observe(monthlyClaro())))).toStrictEqual([
    ["2026-04-05T14:00:00.000Z", "2026-06-05T18:45:00.000Z"],
  ]);
});

it("needs a third occurrence before two intervals become a rhythm", () => {
  const twice = detectRecurringSeries(
    observe([occurrence("2026-04-05T14:00:00Z"), occurrence("2026-05-05T14:00:00Z")])
  );
  const thrice = detectRecurringSeries(observe(monthlyClaro()));

  expect(twice).toHaveLength(0);
  expect(thrice).toHaveLength(1);
});

it("confirms every named cadence from its own realistic spacing", () => {
  const cadencesOf = (dates: ReadonlyArray<string>): ReadonlyArray<string> =>
    detectRecurringSeries(observe(dates.map((date) => occurrence(date)))).map(
      (series) => series.cadence
    );

  expect(
    cadencesOf(["2026-04-02T10:00:00Z", "2026-04-09T10:00:00Z", "2026-04-16T10:00:00Z"])
  ).toStrictEqual(["weekly"]);
  expect(
    cadencesOf(["2026-04-02T10:00:00Z", "2026-04-16T10:00:00Z", "2026-04-30T10:00:00Z"])
  ).toStrictEqual(["fortnightly"]);
  expect(
    cadencesOf(["2026-01-31T10:00:00Z", "2026-02-28T10:00:00Z", "2026-03-31T10:00:00Z"])
  ).toStrictEqual(["monthly"]);
  expect(
    cadencesOf(["2026-01-15T10:00:00Z", "2026-04-15T10:00:00Z", "2026-07-15T10:00:00Z"])
  ).toStrictEqual(["quarterly"]);
  expect(
    cadencesOf(["2024-03-01T10:00:00Z", "2025-03-01T10:00:00Z", "2026-03-01T10:00:00Z"])
  ).toStrictEqual(["yearly"]);
});

it("confirms nothing when the gaps belong to no single cadence", () => {
  const irregular = detectRecurringSeries(
    observe([
      occurrence("2026-04-05T10:00:00Z"),
      occurrence("2026-04-14T10:00:00Z"),
      occurrence("2026-06-05T10:00:00Z"),
    ])
  );

  expect(irregular).toHaveLength(0);
});

it("accepts a gap sitting exactly on either edge of a cadence band", () => {
  const cadencesOf = (dates: ReadonlyArray<string>): ReadonlyArray<string> =>
    detectRecurringSeries(observe(dates.map((date) => occurrence(date)))).map(
      (series) => series.cadence
    );

  expect(
    cadencesOf(["2026-04-02T10:00:00Z", "2026-04-08T10:00:00Z", "2026-04-14T10:00:00Z"])
  ).toStrictEqual(["weekly"]);
  expect(
    cadencesOf(["2026-04-02T10:00:00Z", "2026-04-10T10:00:00Z", "2026-04-18T10:00:00Z"])
  ).toStrictEqual(["weekly"]);
});

it("refuses a cadence that only some of the gaps agree with", () => {
  const partial = detectRecurringSeries(
    observe([
      occurrence("2026-04-01T10:00:00Z"),
      occurrence("2026-05-01T10:00:00Z"),
      occurrence("2026-06-30T10:00:00Z"),
    ])
  );

  expect(partial).toHaveLength(0);
});

it("rejects a gap that falls between two cadence bands", () => {
  const between = detectRecurringSeries(
    observe([
      occurrence("2026-04-01T10:00:00Z"),
      occurrence("2026-04-21T10:00:00Z"),
      occurrence("2026-05-11T10:00:00Z"),
    ])
  );

  expect(between).toHaveLength(0);
});

it("tolerates the drift a real charge shows but not a different charge", () => {
  const drifted = detectRecurringSeries(
    observe([
      occurrence("2026-04-05T10:00:00Z", { amount: "50000" }),
      occurrence("2026-05-05T10:00:00Z", { amount: "52000" }),
      occurrence("2026-06-05T10:00:00Z", { amount: "57500" }),
    ])
  );
  const unrelated = detectRecurringSeries(
    observe([
      occurrence("2026-04-05T10:00:00Z", { amount: "50000" }),
      occurrence("2026-05-05T10:00:00Z", { amount: "52000" }),
      occurrence("2026-06-05T10:00:00Z", { amount: "57501" }),
    ])
  );

  expect(drifted).toHaveLength(1);
  expect(Equal.equals(drifted[0]?.typicalMoney.amount, money("57500").amount)).toBe(true);
  expect(unrelated).toHaveLength(0);
});

it("measures the spread from the cheapest occurrence rather than the earliest", () => {
  const dearestFirst = detectRecurringSeries(
    observe([
      occurrence("2026-04-05T10:00:00Z", { amount: "60000" }),
      occurrence("2026-05-05T10:00:00Z", { amount: "50000" }),
      occurrence("2026-06-05T10:00:00Z", { amount: "57500" }),
    ])
  );

  expect(dearestFirst).toHaveLength(0);
});

it("lists the confirming Transactions oldest first whatever order they arrive in", () => {
  const [series] = detectRecurringSeries(
    observe([
      occurrence("2026-06-05T10:00:00Z", { id: transactionId(73) }),
      occurrence("2026-04-05T10:00:00Z", { id: transactionId(71) }),
      occurrence("2026-05-05T10:00:00Z", { id: transactionId(72) }),
    ])
  );

  expect(series?.occurrences).toStrictEqual([
    transactionId(71),
    transactionId(72),
    transactionId(73),
  ]);
});

it("takes the most recent occurrence as what the charge currently costs", () => {
  const confirmed = detectRecurringSeries(
    observe([
      occurrence("2026-06-05T10:00:00Z", { amount: "54000" }),
      occurrence("2026-04-05T10:00:00Z", { amount: "50000" }),
      occurrence("2026-05-05T10:00:00Z", { amount: "52000" }),
    ])
  );

  expect(Equal.equals(confirmed[0]?.typicalMoney.amount, money("54000").amount)).toBe(true);
  expect(occurrenceWindow(confirmed)).toStrictEqual([
    ["2026-04-05T10:00:00.000Z", "2026-06-05T10:00:00.000Z"],
  ]);
});

it("never forms one series from Transactions in different Currencies", () => {
  const mixed = detectRecurringSeries(
    observe([
      occurrence("2026-04-05T10:00:00Z", { amount: "50000", currency: Currency.make("COP") }),
      occurrence("2026-05-05T10:00:00Z", { amount: "50000", currency: Currency.make("COP") }),
      occurrence("2026-06-05T10:00:00Z", { amount: "12", currency: Currency.make("USD") }),
    ])
  );

  expect(mixed).toHaveLength(0);
});

it("keeps one Counterparty's Currencies as separate series without converting between them", () => {
  const series = detectRecurringSeries(
    observe([
      ...monthlyClaro({ currency: Currency.make("COP"), amount: "50000" }),
      occurrence("2026-04-05T10:00:00Z", { currency: Currency.make("USD"), amount: "12" }),
      occurrence("2026-05-05T10:00:00Z", { currency: Currency.make("USD"), amount: "12" }),
      occurrence("2026-06-05T10:00:00Z", { currency: Currency.make("USD"), amount: "12" }),
    ])
  );

  expect(series.map((entry) => entry.typicalMoney.currency)).toStrictEqual(["COP", "USD"]);
});

it("forms no series from Transactions whose Counterparty was never captured", () => {
  const anonymous = detectRecurringSeries(observe(monthlyClaro({ counterparty: Option.none() })));

  expect(anonymous).toHaveLength(0);
});

it("keeps opposite directions with one Counterparty as separate series", () => {
  const series = detectRecurringSeries(
    observe([...monthlyClaro({ direction: "outflow" }), ...monthlyClaro({ direction: "inflow" })])
  );

  expect(series.map((entry) => entry.direction)).toStrictEqual(["inflow", "outflow"]);
});

it("orders confirmed series by Counterparty, then Currency, then direction", () => {
  const series = detectRecurringSeries(
    observe([
      ...monthlyClaro({ counterparty: Option.some("Netflix") }),
      ...monthlyClaro({ counterparty: Option.some("Claro"), direction: "outflow" }),
      ...monthlyClaro({ counterparty: Option.some("Claro"), direction: "inflow" }),
      ...monthlyClaro({
        counterparty: Option.some("Claro"),
        currency: Currency.make("USD"),
        amount: "12",
      }),
    ])
  );

  expect(
    series.map((entry) => [entry.counterparty, entry.typicalMoney.currency, entry.direction])
  ).toStrictEqual([
    ["Claro", "COP", "inflow"],
    ["Claro", "COP", "outflow"],
    ["Claro", "USD", "outflow"],
    ["Netflix", "COP", "outflow"],
  ]);
});

it("orders two Currencies of one Counterparty and direction alphabetically", () => {
  const series = detectRecurringSeries(
    observe([
      ...monthlyClaro({ currency: Currency.make("USD"), amount: "12" }),
      ...monthlyClaro({ currency: Currency.make("COP"), amount: "50000" }),
    ])
  );

  expect(series.map((entry) => entry.typicalMoney.currency)).toStrictEqual(["COP", "USD"]);
});

it("treats an occurrence landing exactly when watching began as watched, not imported", () => {
  const [series] = detectRecurringSeries(
    observe(monthlyClaro(), {
      observedSince: "2026-06-05T18:45:00Z",
      now: "2026-08-01T00:00:00Z",
    })
  );

  expect(series?.announcement).toStrictEqual({ state: "announceable" });
});

it("suppresses a series on the last day the User's history is too young to be news", () => {
  const [series] = detectRecurringSeries(
    observe(monthlyClaro(), {
      observedSince: "2026-05-10T00:00:00Z",
      now: "2026-06-08T00:00:00Z",
    })
  );

  expect(series?.announcement).toStrictEqual({ state: "suppressed", reason: "cold-start" });
});

it("announces on the first day the cold-start window has fully elapsed", () => {
  const [series] = detectRecurringSeries(
    observe(monthlyClaro(), {
      observedSince: "2026-05-10T00:00:00Z",
      now: "2026-06-09T00:00:00Z",
    })
  );

  expect(series?.announcement).toStrictEqual({ state: "announceable" });
});

it("suppresses a series whose every occurrence predates fidy watching the User", () => {
  const [series] = detectRecurringSeries(
    observe(monthlyClaro(), { observedSince: "2026-07-01T00:00:00Z", now: "2026-08-10T00:00:00Z" })
  );

  expect(series?.announcement).toStrictEqual({ state: "suppressed", reason: "backfill" });
});

it("announces a backfilled series once one occurrence is seen as it happens", () => {
  const [series] = detectRecurringSeries(
    observe(monthlyClaro(), { observedSince: "2026-06-01T00:00:00Z", now: "2026-08-10T00:00:00Z" })
  );

  expect(series?.announcement).toStrictEqual({ state: "announceable" });
});

const detected = (overrides: Partial<DetectedRecurringSeries> = {}): DetectedRecurringSeries => ({
  counterparty: "Claro",
  direction: "outflow",
  cadence: "monthly",
  typicalMoney: money("50000"),
  occurrences: [transactionId(901), transactionId(902), transactionId(903)],
  firstOccurredAt: DateTime.makeUnsafe("2026-04-05T10:00:00Z"),
  lastOccurredAt: DateTime.makeUnsafe("2026-06-05T10:00:00Z"),
  announcement: { state: "announceable" },
  ...overrides,
});

it("summarizes announceable series by explicit Currency and direction", () => {
  const groups = Effect.runSync(
    summarizeConfirmedSeries([
      detected(),
      detected({ typicalMoney: money("30000"), direction: "inflow" }),
      detected({ typicalMoney: money("12", Currency.make("USD")) }),
    ])
  );

  expect(groups.map((group) => group.currency)).toStrictEqual(["COP", "USD"]);
  expect(Equal.equals(groups[0]?.outflow.amount, money("50000").amount)).toBe(true);
  expect(Equal.equals(groups[0]?.inflow.amount, money("30000").amount)).toBe(true);
  expect(Equal.equals(groups[1]?.outflow.amount, money("12", Currency.make("USD")).amount)).toBe(
    true
  );
});

it("withholds suppressed series from the trigger summary", () => {
  const groups = Effect.runSync(
    summarizeConfirmedSeries([
      detected({ announcement: { state: "suppressed", reason: "backfill" } }),
      detected({ announcement: { state: "suppressed", reason: "cold-start" } }),
    ])
  );

  expect(groups).toStrictEqual([]);
});

it("carries no detector evidence into the trigger summary", () => {
  const groups = Effect.runSync(summarizeConfirmedSeries([detected()]));

  expect(Object.keys(groups[0] ?? {}).toSorted()).toStrictEqual(["currency", "inflow", "outflow"]);
});
