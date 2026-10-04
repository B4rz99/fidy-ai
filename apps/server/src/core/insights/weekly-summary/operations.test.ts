import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { buildWeeklySummary, presentWeeklySummary, summarizeWeek } from "./operations";
import { Money } from "~/core/_shared/money";
import { CategoryId, CategoryLabel } from "~/core/categories/contract";
import type { EffectiveTransactionAggregate } from "~/core/transactions/contract";
import { weeklyPeriods } from "~/core/insights/operations";
import { UtcTimestamp } from "~/core/_shared/time";
import { IanaTimeZone } from "~/core/_shared/context";
import { WeeklySummaryPayload } from "./contract";

const periods = weeklyPeriods({
  scheduledAt: Schema.decodeSync(UtcTimestamp)("2026-10-12T23:00:00.000Z"),
  timeZone: IanaTimeZone.make("America/Bogota"),
});
const categoryId = CategoryId.make("00000000-0000-4000-8000-000000000001");
const aggregate = (
  amount: string,
  direction: "inflow" | "outflow" = "outflow",
  options: Readonly<{ currency: "COP" | "USD"; categoryId: CategoryId }> = {
    currency: "COP",
    categoryId,
  }
): EffectiveTransactionAggregate => {
  const currency = options.currency;
  const category = options.categoryId;
  const money = Schema.decodeSync(Money)({ amount, currency });
  return { categoryId: category, direction, sum: money, maximum: money, count: 1n };
};
describe("weekly summary", () => {
  it("presents exact Spanish directional changes and Category labels without hiding unavailable metadata", () => {
    const result = summarizeWeek({
      periods,
      financialRevision: 1,
      current: [aggregate("20.25")],
      previous: [aggregate("40.5")],
    });
    if (result._tag !== "Summary") throw new Error("Expected summary");
    const input = {
      payload: result.payload,
      timeZone: IanaTimeZone.make("America/Bogota"),
      categories: [{ id: categoryId, label: CategoryLabel.make("Mercado") }],
    };
    const presented = presentWeeklySummary(input);
    expect(presented._tag).toBe("Some");
    if (presented._tag !== "Some") throw new Error("Expected presentation");
    expect(presented.value.sections).toEqual([
      {
        currency: "COP",
        text: "Ingresos 0 (sin cambio: 0); salidas 20,25 (disminuyeron: 20,25). Categorías: Mercado 20,25.",
      },
    ]);
    expect(presentWeeklySummary({ ...input, categories: [] })._tag).toBe("None");
  });
  it("retains every Currency, including previous-only activity, without netting directions", () => {
    const result = summarizeWeek({
      periods,
      financialRevision: 1,
      current: [aggregate("9007199254740993.01"), aggregate("2", "inflow")],
      previous: [aggregate("3", "outflow", { currency: "USD", categoryId })],
    });
    expect(result._tag).toBe("Summary");
    if (result._tag !== "Summary") throw new Error("Expected summary");
    const payload = Schema.encodeSync(WeeklySummaryPayload)(result.payload);
    expect(payload.groups.map((group) => group.currency)).toEqual(["COP", "USD"]);
    expect(payload.groups[0].outflow.current.amount).toBe("9007199254740993.01");
    expect(payload.groups[0].inflow.current.amount).toBe("2");
    expect(payload.groups[1]?.outflow.absoluteDelta.amount).toBe("3");
    expect(payload.groups[1]?.outflow.current.amount).toBe("0");
  });
  it("ranks the three leading outflow Categories by exact amount then stable identity", () => {
    const ids = [1, 2, 3, 4].map((index) =>
      CategoryId.make(`00000000-0000-4000-8000-00000000000${index}`)
    );
    const current = ids
      .map((id) => aggregate("10", "outflow", { currency: "COP", categoryId: id }))
      .reverse();
    const result = summarizeWeek({ periods, financialRevision: 1, current, previous: [] });
    if (result._tag !== "Summary") throw new Error("Expected summary");
    expect(
      result.payload.groups[0].topOutflowCategories.map(
        (category: Readonly<{ categoryId: CategoryId }>) => category.categoryId
      )
    ).toEqual(ids.slice(0, 3));
  });
  it("skips genuinely empty current activity even when the comparison week had movements", () => {
    expect(
      summarizeWeek({ periods, financialRevision: 1, current: [], previous: [aggregate("10")] })
    ).toEqual({ _tag: "NoActivity" });
  });
  it("binds the complete financial selections to the captured report bounds", () => {
    const facts = {
      revision: 8,
      periods: [
        { period: periods.current, aggregates: [aggregate("5")] },
        { period: periods.previous, aggregates: [] },
      ],
    } as const;
    expect(buildWeeklySummary({ periods, facts })._tag).toBe("Summary");
    expect(() =>
      buildWeeklySummary({
        periods,
        facts: { ...facts, periods: [facts.periods[1], facts.periods[0]] },
      })
    ).toThrow();
  });
  it("compares exact same-Currency directions with unsigned absolute decreases", () => {
    const result = summarizeWeek({
      periods,
      financialRevision: 7,
      current: [aggregate("20.25"), aggregate("3", "inflow")],
      previous: [aggregate("40.5")],
    });
    expect(result._tag).toBe("Summary");
    if (result._tag !== "Summary") return;
    const payload = Schema.encodeSync(WeeklySummaryPayload)(result.payload);
    expect(payload.groups[0].outflow).toEqual({
      current: { amount: "20.25", currency: "COP" },
      previous: { amount: "40.5", currency: "COP" },
      change: "Decreased",
      absoluteDelta: { amount: "20.25", currency: "COP" },
    });
    expect(payload.groups[0].inflow.change).toBe("Increased");
  });
});
