import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import { WeeklyComparison, WeeklyCurrencyGroup, WeeklySummaryPayload } from "./contract";

const money = (
  amount: string,
  currency = "COP"
): Readonly<{ amount: string; currency: string }> => ({ amount, currency });
const comparison = ({
  current,
  previous,
  change,
  delta,
  currency,
}: Readonly<{
  current: string;
  previous: string;
  change: string;
  delta: string;
  currency: string;
}>): Readonly<{
  current: ReturnType<typeof money>;
  previous: ReturnType<typeof money>;
  change: string;
  absoluteDelta: ReturnType<typeof money>;
}> => ({
  current: money(current, currency),
  previous: money(previous, currency),
  change,
  absoluteDelta: money(delta, currency),
});
const zero = comparison({
  current: "0",
  previous: "0",
  change: "Unchanged",
  delta: "0",
  currency: "COP",
});
const category = (
  id: number,
  amount: string,
  currency = "COP"
): Readonly<{ categoryId: string; outflow: ReturnType<typeof money> }> => ({
  categoryId: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  outflow: money(amount, currency),
});
const group = {
  currency: "COP",
  inflow: zero,
  outflow: comparison({
    current: "100",
    previous: "50",
    change: "Increased",
    delta: "50",
    currency: "COP",
  }),
  topOutflowCategories: [category(1, "60"), category(2, "40")],
};

it("requires exact same-Currency deltas and the matching direction of weekly change", () => {
  for (const [current, previous, change, delta] of [
    ["100", "50", "Increased", "50"],
    ["50", "100", "Decreased", "50"],
    ["50", "50", "Unchanged", "0"],
  ] as const) {
    const value = comparison({ current, previous, change, delta, currency: "COP" });
    expect(Result.isSuccess(Schema.decodeUnknownResult(WeeklyComparison)(value))).toBe(true);
    for (const other of ["Increased", "Decreased", "Unchanged"].filter((name) => name !== change)) {
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(WeeklyComparison)({ ...value, change: other }))
      ).toBe(false);
    }
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WeeklyComparison)({ ...value, absoluteDelta: money("1") })
      )
    ).toBe(false);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WeeklyComparison)({ ...value, previous: money(previous, "USD") })
      )
    ).toBe(false);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WeeklyComparison)({
          ...value,
          absoluteDelta: money(delta, "USD"),
        })
      )
    ).toBe(false);
  }
});

it("requires unique positive same-Currency leaders ordered by Money and then stable identity", () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(WeeklyCurrencyGroup)(group))).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklyCurrencyGroup)({
        ...group,
        topOutflowCategories: [category(1, "50"), category(2, "50")],
      })
    )
  ).toBe(true);
  for (const topOutflowCategories of [
    [],
    [category(1, "0")],
    [category(1, "101")],
    [category(1, "60"), category(2, "60")],
    [category(1, "60"), category(1, "40")],
    [category(2, "40"), category(1, "60")],
    [category(2, "50"), category(1, "50")],
    [category(1, "100", "USD")],
    [category(1, "10"), category(2, "10"), category(3, "10"), category(4, "10")],
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(WeeklyCurrencyGroup)({ ...group, topOutflowCategories })
      )
    ).toBe(false);
  }
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklyCurrencyGroup)({
        ...group,
        inflow: comparison({
          current: "1",
          previous: "0",
          change: "Increased",
          delta: "1",
          currency: "USD",
        }),
      })
    )
  ).toBe(false);
  expect(
    Result.isSuccess(Schema.decodeUnknownResult(WeeklyCurrencyGroup)({ ...group, currency: "USD" }))
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklyCurrencyGroup)({
        ...group,
        inflow: zero,
        outflow: zero,
        topOutflowCategories: [],
      })
    )
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklyCurrencyGroup)({
        ...group,
        inflow: comparison({
          current: "1",
          previous: "0",
          change: "Increased",
          delta: "1",
          currency: "COP",
        }),
        outflow: zero,
        topOutflowCategories: [],
      })
    )
  ).toBe(true);
});

it("requires sorted unique Currency groups and actual current activity in a captured weekly payload", () => {
  const value = {
    periods: {
      current: { from: "2026-10-05T05:00:00Z", toExclusive: "2026-10-12T05:00:00Z" },
      previous: { from: "2026-09-28T05:00:00Z", toExclusive: "2026-10-05T05:00:00Z" },
    },
    financialRevision: 0,
    groups: [group],
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(WeeklySummaryPayload)(value))).toBe(true);
  const usd = {
    currency: "USD",
    inflow: comparison({
      current: "1",
      previous: "0",
      change: "Increased",
      delta: "1",
      currency: "USD",
    }),
    outflow: comparison({
      current: "0",
      previous: "0",
      change: "Unchanged",
      delta: "0",
      currency: "USD",
    }),
    topOutflowCategories: [],
  };
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklySummaryPayload)({ ...value, groups: [group, usd] })
    )
  ).toBe(true);
  for (const groups of [
    [],
    [group, group],
    [usd, group],
    [
      {
        ...group,
        outflow: comparison({
          current: "0",
          previous: "50",
          change: "Decreased",
          delta: "50",
          currency: "COP",
        }),
        topOutflowCategories: [],
      },
    ],
  ]) {
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(WeeklySummaryPayload)({ ...value, groups }))
    ).toBe(false);
  }
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(WeeklySummaryPayload)({ ...value, financialRevision: -1 })
    )
  ).toBe(false);
});

it("requires descending totals even when the smaller leader has an earlier identity", () => {
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(WeeklyCurrencyGroup)({
        ...group,
        topOutflowCategories: [category(1, "40"), category(2, "60")],
      })
    )
  ).toBe(true);
});
it("rejects an otherwise internally consistent outflow comparison in a different Currency", () => {
  const value = {
    ...group,
    outflow: comparison({
      current: "100",
      previous: "50",
      change: "Increased",
      delta: "50",
      currency: "USD",
    }),
    topOutflowCategories: [category(1, "100", "USD")],
  };
  expect(Result.isFailure(Schema.decodeUnknownResult(WeeklyCurrencyGroup)(value))).toBe(true);
});
