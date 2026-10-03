import { expect, it } from "vitest";
import { DateTime, Option, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { TransactionId } from "~/core/transactions/contract";
import { decideAnnouncement, detectMonthlySeries } from "./operations";
import type { RecurringFact } from "./contract";

const defaults = {
  amount: "30000",
  currency: "COP",
  counterparty: "Netflix",
  backfill: false,
  day: "15",
};
const fact = (month: number, overrides: Readonly<Partial<typeof defaults>> = {}): RecurringFact => {
  const input = { ...defaults, ...overrides };
  return {
    id: TransactionId.make(`10000000-0000-4000-8000-${String(month).padStart(12, "0")}`),
    money: Schema.decodeSync(Schema.toCodecJson(Money))(input),
    counterparty: input.counterparty === "" ? Option.none() : Option.some(input.counterparty),
    occurredAt: DateTime.makeUnsafe(
      `2026-${String(month).padStart(2, "0")}-${input.day}T12:00:00.000Z`
    ),
    backfill: input.backfill,
  };
};
const zone = IanaTimeZone.make("America/Bogota");

it.each([
  { reason: "fewer than three occurrences", facts: [fact(1), fact(2)] },
  { reason: "different Currency", facts: [fact(1), fact(2), fact(3, { currency: "USD" })] },
  {
    reason: "missing explicit Counterparty",
    facts: [fact(1), fact(2), fact(3, { counterparty: "" })],
  },
  {
    reason: "one minor unit beyond five percent",
    facts: [fact(1), fact(2), fact(3, { amount: "31500.01" })],
  },
  {
    reason: "more than three days of calendar drift",
    facts: [fact(1), fact(2, { day: "19" }), fact(3)],
  },
  { reason: "a missing calendar month", facts: [fact(1), fact(2), fact(4)] },
])("does not confirm $reason", ({ facts }: Readonly<{ facts: ReadonlyArray<RecurringFact> }>) => {
  expect(detectMonthlySeries({ facts, timeZone: zone })).toEqual([]);
});

it("clamps a month-end anchor through February without treating monthly cadence as thirty days", () => {
  const proposals = detectMonthlySeries({
    facts: [
      fact(1, { day: "31" }),
      fact(2, { day: "28" }),
      fact(3, { day: "31" }),
      fact(4, { day: "30" }),
    ],
    timeZone: zone,
  });
  expect(proposals).toHaveLength(1);
  expect(
    DateTime.formatIso(Option.getOrThrow(Option.fromUndefinedOr(proposals[0])).lastOccurredAt)
  ).toBe("2026-04-30T12:00:00.000Z");
});

it("rejects ambiguous assignments rather than greedily choosing one equal-month charge", () => {
  const duplicate = { ...fact(2), id: TransactionId.make("90000000-0000-4000-8000-000000000001") };
  expect(
    detectMonthlySeries({ facts: [fact(1), fact(2), duplicate, fact(3)], timeZone: zone })
  ).toEqual([]);
});

it("keeps the first Money reference fixed instead of compounding small price changes", () => {
  const proposals = detectMonthlySeries({
    facts: [
      fact(1),
      fact(2, { amount: "30600" }),
      fact(3, { amount: "31200" }),
      fact(4, { amount: "31800" }),
      fact(5, { amount: "32400" }),
    ],
    timeZone: zone,
  });
  expect(proposals).toHaveLength(1);
  expect(
    Schema.encodeSync(Schema.toCodecJson(Money))(
      Option.getOrThrow(Option.fromUndefinedOr(proposals[0])).money
    )
  ).toEqual({ amount: "31200", currency: "COP" });
});

it("deduplicates repeated identities without inventing a third occurrence", () => {
  expect(detectMonthlySeries({ facts: [fact(1), fact(2), fact(2)], timeZone: zone })).toEqual([]);
});

it("fixes backfill suppression before cold start and opens eligibility exactly after thirty days", () => {
  const thirtyDays = 2_592_000_000;
  expect(
    decideAnnouncement({ backfill: true, firstCapturedAt: 0, confirmedAt: thirtyDays + 1 })
  ).toEqual({ kind: "suppressed", reason: "backfill" });
  expect(
    decideAnnouncement({ backfill: false, firstCapturedAt: 0, confirmedAt: thirtyDays - 1 })
  ).toEqual({ kind: "suppressed", reason: "cold-start" });
  expect(
    decideAnnouncement({ backfill: false, firstCapturedAt: 0, confirmedAt: thirtyDays })
  ).toEqual({ kind: "eligible" });
});

it("retains the original confirmation evidence while a resumed charge updates latest Money", () => {
  const proposals = detectMonthlySeries({
    facts: [fact(1), fact(2), fact(3), fact(6, { amount: "31000" })],
    timeZone: zone,
  });
  expect(proposals).toHaveLength(1);
  expect(
    DateTime.formatIso(Option.getOrThrow(Option.fromUndefinedOr(proposals[0])).lastOccurredAt)
  ).toBe("2026-06-15T12:00:00.000Z");
});

it("confirms three calendar-month charges and exposes the latest exact Money", () => {
  const latest = fact(3, {
    amount: "31500",
    counterparty: "  NETFLIX  ",
  });
  const proposals = detectMonthlySeries({ facts: [fact(1), fact(2), latest], timeZone: zone });
  expect(proposals).toHaveLength(1);
  expect(
    Schema.encodeSync(Schema.toCodecJson(Money))(
      Option.getOrThrow(Option.fromUndefinedOr(proposals[0])).money
    )
  ).toEqual({
    amount: "31500",
    currency: "COP",
  });
  expect(proposals[0]?.supportingTransactionIds).toEqual([fact(1).id, fact(2).id, latest.id]);
});

it("rejects overlapping amount bands before greedily assigning their shared middle-month charge", () => {
  const secondJanuary = {
    ...fact(1, { amount: "110" }),
    id: TransactionId.make("90000000-0000-4000-8000-000000000011"),
  };
  const secondMarch = {
    ...fact(3, { amount: "110" }),
    id: TransactionId.make("90000000-0000-4000-8000-000000000013"),
  };
  expect(
    detectMonthlySeries({
      facts: [
        fact(1, { amount: "100" }),
        secondJanuary,
        fact(2, { amount: "105" }),
        fact(3, { amount: "100" }),
        secondMarch,
      ],
      timeZone: zone,
    })
  ).toEqual([]);
});

it("rejects two calendar anchors that share one charge inside both drift allowances", () => {
  const secondJanuary = {
    ...fact(1, { day: "18" }),
    id: TransactionId.make("90000000-0000-4000-8000-000000000021"),
  };
  const secondMarch = {
    ...fact(3, { day: "18" }),
    id: TransactionId.make("90000000-0000-4000-8000-000000000023"),
  };
  expect(
    detectMonthlySeries({
      facts: [fact(1, { day: "12" }), secondJanuary, fact(2), fact(3, { day: "12" }), secondMarch],
      timeZone: zone,
    })
  ).toEqual([]);
});
