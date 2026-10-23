import { expect, it } from "vitest";
import { DateTime, Option, Result, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { TransactionId } from "~/core/transactions/contract";
import { decideAnnouncement, detectMonthlySeries, normalizeCounterparty } from "./operations";
import { type RecurringFact, RecurringProposal, RecurringSeriesPage } from "./contract";

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

it("ignores ambiguous later months while extending to the latest unique charge across years", () => {
  const duplicate = {
    ...fact(6),
    id: TransactionId.make("90000000-0000-4000-8000-000000000031"),
  };
  const nextYear = {
    ...fact(1),
    id: TransactionId.make("90000000-0000-4000-8000-000000000032"),
    occurredAt: DateTime.makeUnsafe("2027-01-15T12:00:00.000Z"),
  };
  const facts = [fact(1), fact(2), fact(3), fact(6), duplicate];
  const ambiguous = detectMonthlySeries({ facts, timeZone: zone });
  expect(ambiguous).toHaveLength(1);
  expect(ambiguous[0]?.latestTransactionId).toBe(fact(3).id);
  const extended = detectMonthlySeries({ facts: [...facts, nextYear], timeZone: zone });
  expect(extended).toHaveLength(1);
  expect(extended[0]?.latestTransactionId).toBe(nextYear.id);
  expect(extended[0]?.supportingTransactionIds).toEqual([fact(1).id, fact(2).id, fact(3).id]);
});

it("normalizes explicit Counterparty formatting without removing accents or joining separate words", () => {
  expect(normalizeCounterparty("  CAFÉ\u00a0  CENTRAL  ")).toBe("café central");
  expect(normalizeCounterparty("ＣＡＦＥ")).toBe("cafe");
  expect(normalizeCounterparty("A B")).not.toBe(normalizeCounterparty("AB"));
});

it("includes the three-day drift boundary and preserves backfill from any confirming month", () => {
  for (const month of [1, 2, 3]) {
    const facts = [
      fact(1, { backfill: month === 1 }),
      fact(2, { day: "18", backfill: month === 2 }),
      fact(3, { backfill: month === 3 }),
    ];
    const proposals = detectMonthlySeries({ facts, timeZone: zone });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.backfill).toBe(true);
  }
  expect(
    detectMonthlySeries({ facts: [fact(1), fact(2), fact(3)], timeZone: zone })[0]?.backfill
  ).toBe(false);
});

it("confirms across a year boundary regardless of input order and preserves the original Money reference", () => {
  const january = { ...fact(1), occurredAt: DateTime.makeUnsafe("2027-01-15T12:00:00Z") };
  const february = { ...fact(2), occurredAt: DateTime.makeUnsafe("2027-02-15T12:00:00Z") };
  const december = fact(12);
  const proposals = detectMonthlySeries({ facts: [february, december, january], timeZone: zone });
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.supportingTransactionIds).toEqual([december.id, january.id, february.id]);
  expect(proposals[0]?.latestTransactionId).toBe(february.id);
  expect(proposals[0]?.referenceMoney).toEqual(december.money);
});

it("keeps equal-Money recurring charges for distinct explicit Counterparties independent", () => {
  const netflix = [fact(1), fact(2), fact(3)];
  const spotify = [1, 2, 3, 6].map((month) => ({
    ...fact(month, { counterparty: "Spotify" }),
    id: TransactionId.make(`90000000-0000-4000-8000-${String(month).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({
    facts: [...netflix, ...spotify].toReversed(),
    timeZone: zone,
  });
  expect(proposals).toHaveLength(2);
  expect(
    proposals.find((proposal) => proposal.counterparty === "Netflix")?.latestTransactionId
  ).toBe(fact(3).id);
  expect(
    proposals.find((proposal) => proposal.counterparty === "Spotify")?.latestTransactionId
  ).toBe(spotify[3]?.id);
});

it("keeps distinct non-overlapping Money bands for the same Counterparty as separate historical patterns", () => {
  const lower = [
    fact(1, { amount: "100" }),
    fact(2, { amount: "100" }),
    fact(3, { amount: "100" }),
  ];
  const higher = [
    fact(4, { amount: "200" }),
    fact(5, { amount: "200" }),
    fact(6, { amount: "200" }),
  ];
  const proposals = detectMonthlySeries({ facts: [...lower, ...higher], timeZone: zone });
  expect(proposals).toHaveLength(2);
  expect(proposals.map((proposal) => proposal.supportingTransactionIds)).toEqual([
    [fact(1).id, fact(2).id, fact(3).id],
    [fact(4).id, fact(5).id, fact(6).id],
  ]);
});

it("freezes the first confirming triple, reference Money and backfill status when later triples extend it", () => {
  const facts = [
    fact(1, { backfill: true }),
    fact(2, { amount: "30600" }),
    fact(3, { amount: "31000" }),
    fact(4, { amount: "31200" }),
  ];
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.supportingTransactionIds).toEqual([fact(1).id, fact(2).id, fact(3).id]);
  expect(proposals[0]?.referenceMoney).toEqual(fact(1).money);
  expect(proposals[0]?.firstOccurredAt).toEqual(fact(1).occurredAt);
  expect(proposals[0]?.backfill).toBe(true);
  expect(proposals[0]?.latestTransactionId).toBe(fact(4).id);
});

it("validates unique supporting Transaction identities before retaining a recurring proposal", () => {
  const proposal = {
    counterparty: "Netflix",
    money: { amount: "30000", currency: "COP" },
    referenceMoney: { amount: "30000", currency: "COP" },
    firstOccurredAt: "2026-01-15T12:00:00.000Z",
    lastOccurredAt: "2026-03-15T12:00:00.000Z",
    supportingTransactionIds: [fact(1).id, fact(2).id, fact(3).id],
    latestTransactionId: fact(3).id,
    backfill: false,
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(RecurringProposal)(proposal))).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(RecurringProposal)({
        ...proposal,
        supportingTransactionIds: [fact(1).id, fact(1).id, fact(3).id],
      })
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(RecurringProposal)({
        ...proposal,
        money: { amount: "0", currency: "COP" },
      })
    )
  ).toBe(true);
  const page = {
    series: [
      {
        id: fact(1).id,
        counterparty: "Netflix",
        money: proposal.money,
        cadence: { kind: "monthly" },
        firstOccurredAt: proposal.firstOccurredAt,
        lastOccurredAt: proposal.lastOccurredAt,
        confirmedAt: proposal.lastOccurredAt,
        announcement: { kind: "suppressed", reason: "backfill" },
      },
    ],
    evaluation: { kind: "updating" },
  };
  expect(
    Schema.encodeSync(RecurringSeriesPage)(Schema.decodeUnknownSync(RecurringSeriesPage)(page))
  ).toEqual(page);
});

it("rejects a competing first-month anchor even when its asymmetric Money band cannot form a triple", () => {
  const competing = {
    ...fact(1, { amount: "105.01" }),
    id: TransactionId.make("90000000-0000-4000-8000-000000000041"),
  };
  expect(
    detectMonthlySeries({
      facts: [
        fact(1, { amount: "100" }),
        competing,
        fact(2, { amount: "103" }),
        fact(3, { amount: "103" }),
      ],
      timeZone: zone,
    })
  ).toEqual([]);
});

it("rejects competing first-month anchors at asymmetric Money boundaries", () => {
  const charges = [
    { month: 2, id: 1, amount: "100", day: 15, name: "Netflix" },
    { month: 2, id: 2, amount: "105.01", day: 18, name: " NETFLIX " },
    { month: 3, id: 3, amount: "100", day: 15, name: "Netflix" },
    { month: 4, id: 5, amount: "105", day: 18, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([]);
});

it("retains a later independent triple after earlier shared evidence is rejected", () => {
  const charges = [
    { month: 1, id: 1, amount: "105.01", day: 18, name: " NETFLIX " },
    { month: 2, id: 2, amount: "105", day: 18, name: "Netflix" },
    { month: 3, id: 3, amount: "100", day: 15, name: "Netflix" },
    { month: 4, id: 4, amount: "100", day: 15, name: " NETFLIX " },
    { month: 5, id: 5, amount: "100", day: 15, name: "Netflix" },
    { month: 6, id: 6, amount: "100", day: 12, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [4, 5, 6],
      latestId: 6,
      referenceAmount: "100",
      amount: "100",
      counterparty: "Netflix",
    },
  ]);
});

it("requires mutual comparability before treating overlapping triples as one pattern", () => {
  const charges = [
    { month: 5, id: 5, amount: "100", day: 15, name: " NETFLIX " },
    { month: 4, id: 4, amount: "100", day: 18, name: " NETFLIX " },
    { month: 3, id: 3, amount: "105.01", day: 15, name: "Netflix" },
    { month: 6, id: 7, amount: "103", day: 18, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([]);
});

it("keeps the original calendar anchor when a later triple resumes", () => {
  const charges = [
    { month: 1, id: 2, amount: "105", day: 12, name: "Netflix" },
    { month: 2, id: 3, amount: "100", day: 15, name: "Netflix" },
    { month: 3, id: 5, amount: "105", day: 15, name: " NETFLIX " },
    { month: 5, id: 7, amount: "100", day: 18, name: "Netflix" },
    { month: 6, id: 8, amount: "100", day: 15, name: "Netflix" },
    { month: 7, id: 9, amount: "100", day: 15, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [2, 3, 5],
      latestId: 9,
      referenceAmount: "105",
      amount: "100",
      counterparty: "Netflix",
    },
  ]);
});

it("does not reset retained evidence when exactly one historical proposal matches", () => {
  const charges = [
    { month: 1, id: 2, amount: "105", day: 12, name: "Netflix" },
    { month: 2, id: 3, amount: "100", day: 15, name: "Netflix" },
    { month: 3, id: 5, amount: "105", day: 15, name: " NETFLIX " },
    { month: 5, id: 7, amount: "100", day: 18, name: "Netflix" },
    { month: 6, id: 8, amount: "100", day: 15, name: "Netflix" },
    { month: 7, id: 9, amount: "100", day: 15, name: "Netflix" },
    { month: 8, id: 10, amount: "100", day: 18, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [2, 3, 5],
      latestId: 9,
      referenceAmount: "105",
      amount: "100",
      counterparty: "Netflix",
    },
  ]);
});

it("permits already-assigned evidence only within the same historical proposal", () => {
  const charges = [
    { month: 8, id: 8, amount: "105.01", day: 15, name: "Netflix" },
    { month: 9, id: 10, amount: "103", day: 15, name: "Netflix" },
    { month: 10, id: 12, amount: "100", day: 15, name: "Netflix" },
    { month: 11, id: 13, amount: "103", day: 15, name: "Netflix" },
    { month: 11, id: 14, amount: "110", day: 15, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [8, 10, 12],
      latestId: 13,
      referenceAmount: "105.01",
      amount: "103",
      counterparty: "Netflix",
    },
  ]);
});

it("does not extend a proposal with a charge eligible for two Money bands", () => {
  const charges = [
    { month: 1, id: 1, amount: "100", day: 15, name: "Netflix" },
    { month: 2, id: 2, amount: "100", day: 15, name: "Netflix" },
    { month: 3, id: 3, amount: "103", day: 15, name: "Netflix" },
    { month: 6, id: 5, amount: "105.01", day: 12, name: " NETFLIX " },
    { month: 7, id: 6, amount: "103", day: 15, name: "Netflix" },
    { month: 8, id: 8, amount: "105", day: 12, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [1, 2, 3],
      latestId: 3,
      referenceAmount: "100",
      amount: "103",
      counterparty: "Netflix",
    },
    {
      supportingIds: [5, 6, 8],
      latestId: 8,
      referenceAmount: "105.01",
      amount: "105",
      counterparty: "Netflix",
    },
  ]);
});

it("keeps historical proposals unchanged when all later charges are ambiguous", () => {
  const charges = [
    { month: 9, id: 11, amount: "105.01", day: 18, name: " NETFLIX " },
    { month: 3, id: 4, amount: "105", day: 18, name: "Netflix" },
    { month: 2, id: 2, amount: "105.01", day: 15, name: " NETFLIX " },
    { month: 7, id: 9, amount: "110", day: 15, name: " NETFLIX " },
    { month: 8, id: 10, amount: "110", day: 15, name: "Netflix" },
    { month: 1, id: 1, amount: "103", day: 15, name: "Netflix" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([
    {
      supportingIds: [1, 2, 4],
      latestId: 4,
      referenceAmount: "103",
      amount: "105",
      counterparty: "Netflix",
    },
    {
      supportingIds: [9, 10, 11],
      latestId: 11,
      referenceAmount: "110",
      amount: "105.01",
      counterparty: " NETFLIX ",
    },
  ]);
});

it("excludes charges with no explicit Counterparty", () => {
  const charges = [
    { month: 6, id: 8, amount: "110", day: 18, name: "" },
    { month: 5, id: 7, amount: "110", day: 15, name: "" },
    { month: 4, id: 6, amount: "115", day: 18, name: "" },
  ];
  const facts = charges.map((charge: Readonly<(typeof charges)[number]>) => ({
    ...fact(charge.month, {
      amount: charge.amount,
      day: String(charge.day).padStart(2, "0"),
      counterparty: charge.name,
    }),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(charge.id).padStart(12, "0")}`),
  }));
  const proposals = detectMonthlySeries({ facts, timeZone: zone });
  expect(
    proposals.map((proposal) => ({
      supportingIds: proposal.supportingTransactionIds.map((id) => Number(id.slice(-12))),
      latestId: Number(proposal.latestTransactionId.slice(-12)),
      referenceAmount: Schema.encodeSync(Money)(proposal.referenceMoney).amount,
      amount: Schema.encodeSync(Money)(proposal.money).amount,
      counterparty: proposal.counterparty,
    }))
  ).toEqual([]);
});

it("orders recurring evidence by occurrence time when Transaction identities sort in reverse", () => {
  const facts = [1, 2, 3, 4].map((month) => ({
    ...fact(month),
    id: TransactionId.make(`10000000-0000-4000-8000-${String(10 - month).padStart(12, "0")}`),
  }));
  expect(
    detectMonthlySeries({ facts: facts.toReversed(), timeZone: zone })[0]?.supportingTransactionIds
  ).toEqual(facts.slice(0, 3).map((entry: RecurringFact) => entry.id));
});

it("does not assign a later triple to either of two compatible historical proposals", () => {
  const facts = [
    ...[1, 2, 3].map((month) => fact(month, { amount: "100" })),
    ...[5, 6, 7].map((month) => fact(month, { amount: "110" })),
    ...[9, 10, 11].map((month) => fact(month, { amount: "105" })),
  ];
  expect(
    detectMonthlySeries({ facts, timeZone: zone }).map((proposal) => proposal.latestTransactionId)
  ).toEqual([fact(3).id, fact(7).id]);
});
