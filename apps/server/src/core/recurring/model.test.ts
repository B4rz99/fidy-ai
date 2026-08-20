import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  DetectedRecurringSeries,
  RecurringAnnouncement,
  RecurringCurrencyGroup,
  RecurringDetectionOutcome,
  RecurringSeries,
  RecurringSeriesReport,
} from "./model";

const occurrenceIds = [
  "f1d1a000-0000-4000-8000-000000000001",
  "f1d1a000-0000-4000-8000-000000000002",
  "f1d1a000-0000-4000-8000-000000000003",
] as const;

const seriesInput = {
  id: "f1d1a000-0000-4000-8000-0000000000aa",
  counterparty: "Claro",
  direction: "outflow",
  cadence: "monthly",
  typicalMoney: { amount: "50000", currency: "COP" },
  occurrences: occurrenceIds,
  firstOccurredAt: "2026-04-05T10:00:00Z",
  lastOccurredAt: "2026-06-05T10:00:00Z",
  announcement: { state: "announceable" },
  detectedAt: "2026-06-06T00:00:00Z",
} as const;

const decodeSeries = Schema.decodeUnknownResult(RecurringSeries);
const failureText = (result: Result.Result<unknown, unknown>): string =>
  Result.isFailure(result) ? String(result.failure) : "";

it("accepts a recorded RecurringSeries carrying nested Money and its confirming Transactions", () => {
  expect(Result.isSuccess(decodeSeries(seriesInput))).toBe(true);
});

it("rejects a series confirmed by fewer than three occurrences", () => {
  const decoded = decodeSeries({ ...seriesInput, occurrences: occurrenceIds.slice(0, 2) });

  expect(failureText(decoded)).toContain('["occurrences"]');
});

it("rejects a series that counts one Transaction twice to reach three occurrences", () => {
  const decoded = decodeSeries({
    ...seriesInput,
    occurrences: [occurrenceIds[0], occurrenceIds[1], occurrenceIds[1]],
  });

  expect(failureText(decoded)).toContain('["occurrences"]');
});

it("rejects a series whose occurrence moves no Money", () => {
  const decoded = decodeSeries({
    ...seriesInput,
    typicalMoney: { amount: "0", currency: "COP" },
  });

  expect(failureText(decoded)).toContain('["typicalMoney"]["amount"]');
});

it("rejects an occurrence window that ends before it begins", () => {
  const decoded = decodeSeries({
    ...seriesInput,
    firstOccurredAt: "2026-06-05T10:00:00Z",
    lastOccurredAt: "2026-04-05T10:00:00Z",
  });

  expect(failureText(decoded)).toContain('["lastOccurredAt"]');
});

it("accepts a window whose single-day series begins and ends at the same instant", () => {
  const decoded = decodeSeries({
    ...seriesInput,
    firstOccurredAt: "2026-06-05T10:00:00Z",
    lastOccurredAt: "2026-06-05T10:00:00Z",
  });

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("rejects a detected series that already claims an identity", () => {
  const decoded = Schema.decodeUnknownResult(DetectedRecurringSeries, {
    onExcessProperty: "error",
  })(seriesInput);

  expect(Result.isFailure(decoded)).toBe(true);
});

it("requires a suppressed announcement to say why and an announceable one not to", () => {
  const decodeAnnouncement = Schema.decodeUnknownResult(RecurringAnnouncement, {
    onExcessProperty: "error",
  });

  expect(Result.isFailure(decodeAnnouncement({ state: "suppressed" }))).toBe(true);
  expect(Result.isSuccess(decodeAnnouncement({ state: "suppressed", reason: "cold-start" }))).toBe(
    true
  );
  expect(Result.isFailure(decodeAnnouncement({ state: "announceable", reason: "backfill" }))).toBe(
    true
  );
});

it("accepts a detection outcome whose trigger payload is Currency-grouped Money alone", () => {
  const decoded = Schema.decodeUnknownResult(RecurringDetectionOutcome, {
    onExcessProperty: "error",
  })({
    confirmed: [seriesInput],
    announcement: [
      {
        currency: "COP",
        inflow: { amount: "0", currency: "COP" },
        outflow: { amount: "50000", currency: "COP" },
      },
    ],
  });

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("accepts a detection outcome that confirmed series but has nothing to announce", () => {
  const decoded = Schema.decodeUnknownResult(RecurringDetectionOutcome)({
    confirmed: [{ ...seriesInput, announcement: { state: "suppressed", reason: "backfill" } }],
    announcement: [],
  });

  expect(Result.isSuccess(decoded)).toBe(true);
});

const groupInput = {
  currency: "COP",
  series: [seriesInput],
  perOccurrence: {
    currency: "COP",
    inflow: { amount: "0", currency: "COP" },
    outflow: { amount: "50000", currency: "COP" },
  },
} as const;

it("accepts a Currency group whose series and totals share its denomination", () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(RecurringCurrencyGroup)(groupInput))).toBe(
    true
  );
});

it("rejects a Currency group holding a series denominated in another Currency", () => {
  const decoded = Schema.decodeUnknownResult(RecurringCurrencyGroup)({
    ...groupInput,
    series: [{ ...seriesInput, typicalMoney: { amount: "12", currency: "USD" } }],
  });

  expect(failureText(decoded)).toContain('["series"][0]["typicalMoney"]["currency"]');
});

it("rejects a Currency group whose totals are denominated in another Currency", () => {
  const decoded = Schema.decodeUnknownResult(RecurringCurrencyGroup)({
    ...groupInput,
    perOccurrence: {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "12", currency: "USD" },
    },
  });

  expect(failureText(decoded)).toContain('["perOccurrence"]["currency"]');
});

it("rejects a report whose Currency groups repeat or fall out of alphabetic order", () => {
  const usdGroup = {
    currency: "USD",
    series: [{ ...seriesInput, typicalMoney: { amount: "12", currency: "USD" } }],
    perOccurrence: {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "12", currency: "USD" },
    },
  };
  const decodeReport = Schema.decodeUnknownResult(RecurringSeriesReport);

  expect(Result.isSuccess(decodeReport({ groups: [groupInput, usdGroup] }))).toBe(true);
  expect(failureText(decodeReport({ groups: [usdGroup, groupInput] }))).toContain(
    '["groups"][1]["currency"]'
  );
  expect(failureText(decodeReport({ groups: [groupInput, groupInput] }))).toContain(
    '["groups"][1]["currency"]'
  );
});

it("accepts an empty report as the answer that nothing repeats yet", () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(RecurringSeriesReport)({ groups: [] }))).toBe(
    true
  );
});
