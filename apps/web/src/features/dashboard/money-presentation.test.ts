import { BigDecimal, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  exactChartAmount,
  formatMoney,
  moneyProgressGeometry,
  moneySeriesGeometry,
} from "./money-presentation";

const money = (
  amount: string,
  currency: "COP" | "USD" = "USD"
): Readonly<{ amount: BigDecimal.BigDecimal; currency: "COP" | "USD" }> => ({
  amount: BigDecimal.fromStringUnsafe(amount),
  currency,
});

describe("Dashboard exact Money presentation", () => {
  it("formats authoritative decimal text above Number.MAX_SAFE_INTEGER", () => {
    expect(formatMoney({ money: money("9007199254740993.12"), locale: "es-CO" })).toBe(
      "USD 9.007.199.254.740.993,12"
    );
  });

  it("keeps malformed chart payloads absent instead of inventing authoritative Money", () => {
    expect(Option.isNone(exactChartAmount({ payload: {}, series: "inflow" }))).toBe(true);
    expect(
      Option.getOrThrow(
        exactChartAmount({
          payload: { inflowExact: "9007199254740993.12", outflowExact: "0" },
          series: "inflow",
        })
      )
    ).toBe("9007199254740993.12");
  });

  it("derives only bounded dimensionless chart and progress geometry", () => {
    expect(
      moneySeriesGeometry([
        BigDecimal.fromStringUnsafe("900719925474099312000000000000000000000"),
        BigDecimal.fromStringUnsafe("450359962737049656000000000000000000000"),
      ])
    ).toEqual([1, 0.5]);
    expect(moneyProgressGeometry({ spent: money("150"), cap: money("100") })).toBe(100);
    expect(moneyProgressGeometry({ spent: money("1"), cap: money("0") })).toBe(0);
  });
});
