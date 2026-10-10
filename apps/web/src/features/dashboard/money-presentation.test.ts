import { BigDecimal, Option } from "effect";
import { formatMoney as formatTransactionMoney } from "@/transport/money";
import { describe, expect, it } from "vitest";
import {
  exactChartAmount,
  formatCurrencyAmount,
  formatMoney,
  moneyDecimalText,
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
      "$ 9.007.199.254.740.993,12"
    );
  });

  it("preserves exact Money beyond binary-number finiteness in all presenters", () => {
    const amount = "1" + "0".repeat(400);
    const value = money(amount);
    expect(moneyDecimalText(value)).toBe("1e+400");
    expect(formatMoney({ money: value, locale: "es-CO" }).replace(/[^0-9]/gu, "")).toBe(
      amount + "00"
    );
    expect(formatTransactionMoney({ money: value, locale: "es-CO" }).replace(/[^0-9]/gu, "")).toBe(
      amount + "00"
    );
    expect(moneySeriesGeometry([value.amount, BigDecimal.fromStringUnsafe("1")])).toEqual([1, 0]);
  });

  it("rounds decimal text at Currency display precision, carrying into an enormous integer", () => {
    expect(
      formatCurrencyAmount({ amount: "9007199254740993.125", currency: "USD", locale: "es-CO" })
    ).toBe("$ 9.007.199.254.740.993,13");
    const amount = "1" + "0".repeat(400);
    expect(
      formatCurrencyAmount({ amount: amount + ".995", currency: "USD", locale: "es-CO" }).replace(
        /[^0-9]/gu,
        ""
      )
    ).toBe((BigInt(amount) + 1n).toString() + "00");
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

  it("reads actual outflow-only chart rows without requiring an unused inflow field", () => {
    const amount = "1" + "0".repeat(400);
    const exact = Option.getOrThrow(
      exactChartAmount({ payload: { outflowExact: amount }, series: "outflow" })
    );
    expect(
      formatCurrencyAmount({ amount: exact, currency: "USD", locale: "es-CO" }).replace(
        /[^0-9]/gu,
        ""
      )
    ).toBe(amount + "00");
    expect(exactChartAmount({ payload: { outflowExact: amount }, series: "inflow" })).toEqual(
      Option.none()
    );
    expect(exactChartAmount({ payload: { outflowExact: 10 }, series: "outflow" })).toEqual(
      Option.none()
    );
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
