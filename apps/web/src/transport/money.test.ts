import { BigDecimal } from "effect";
import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyWithCode, formatMoneyWithCompactCode } from "./money";

describe("Explicit currency Money", () => {
  it.each([
    ["COP", "12345678901.99", "COP 12.345.678.901,99"],
    ["USD", "12345678901.99", "USD 12.345.678.901,99"],
    ["KWD", "0.001", "KWD 0,001"],
    ["JPY", "1", "JPY 1"],
    ["USD", "9007199254740993.12", "USD 9.007.199.254.740.993,12"],
  ])("identifies %s once while preserving exact precision", (currency, amount, expected) => {
    expect(
      formatMoneyWithCode({
        locale: "es-CO",
        money: { currency, amount: BigDecimal.fromStringUnsafe(amount) },
      })
    ).toBe(expected);
  });
  it("preserves existing symbol presentation for other surfaces", () => {
    expect(
      formatMoney({
        locale: "es-CO",
        money: { currency: "USD", amount: BigDecimal.fromStringUnsafe("12.34") },
      })
    ).toBe("$ 12,34");
  });
});

describe("Compact explicit-currency Money", () => {
  it.each([
    ["COP", "28900", "$ 28.900 COP"],
    ["COP", "28900.00", "$ 28.900 COP"],
    ["COP", "28900.50", "$ 28.900,50 COP"],
    ["COP", "9007199254740993", "$ 9.007.199.254.740.993 COP"],
    ["USD", "9007199254740993.12", "$ 9.007.199.254.740.993,12 USD"],
  ])("keeps %s %s exact while omitting only empty fractions", (currency, amount, expected) => {
    expect(
      formatMoneyWithCompactCode({
        locale: "es-CO",
        money: { currency, amount: BigDecimal.fromStringUnsafe(amount) },
      })
    ).toBe(expected);
  });
});
